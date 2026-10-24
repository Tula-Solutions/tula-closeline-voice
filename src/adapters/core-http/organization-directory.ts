import {
  ERRORS,
  internalDirectoryMembershipResponseSchema,
  internalDirectoryRepCheckResponseSchema,
  internalDirectoryTeamCheckResponseSchema,
  internalDirectoryTeamRepsResponseSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { z } from 'zod'
import type { OrganizationDirectory } from '~/ports/organization-directory'

/** The longest one attempt at core may take, in milliseconds. */
export const CORE_DIRECTORY_TIMEOUT_MS = 3_000
/** Retries after a network error, timeout or 5xx, on top of the first attempt. */
export const CORE_DIRECTORY_RETRIES = 2
/** The base of the exponential backoff between attempts, in milliseconds. */
const BACKOFF_BASE_MS = 100

/** Options for {@link createCoreHttpOrganizationDirectory}. */
export type CoreHttpDirectoryOptions = {
  /** Core's origin, for example `https://core.internal`. */
  baseUrl: string
  /** The internal bearer secret core lists in its INTERNAL_API_TOKENS. Never logged. */
  token: string
  /** Per-attempt timeout; defaults to {@link CORE_DIRECTORY_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Retries after a failed attempt; defaults to {@link CORE_DIRECTORY_RETRIES}. */
  retries?: number
  /** The HTTP client; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Waits between attempts; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
  /** Jitter source in [0, 1); defaults to `Math.random`. */
  random?: () => number
}

const unavailable = (): AppError =>
  new AppError({
    code: ERRORS['server.unavailable'].code,
    status: ERRORS['server.unavailable'].status,
    message: ERRORS['server.unavailable'].message,
  })

/**
 * The directory over core's internal HTTP routes. Any failure (network, timeout, 4xx, 5xx after
 * the bounded retries, or a body the contract does not accept) is `server.unavailable`, so the
 * caller fails closed. Only network errors, timeouts and 5xx are retried; every call is a read, so
 * a retry is safe.
 */
export function createCoreHttpOrganizationDirectory(
  options: CoreHttpDirectoryOptions
): OrganizationDirectory {
  const base = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? CORE_DIRECTORY_TIMEOUT_MS
  const retries = options.retries ?? CORE_DIRECTORY_RETRIES
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  async function attempt(path: string, body: unknown): Promise<Response | undefined> {
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => {})
        return undefined
      }
      return response
    } catch {
      return undefined
    }
  }

  async function call<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S
  ): Promise<z.output<S>> {
    for (let n = 0; n <= retries; n++) {
      if (n > 0) {
        await sleep(BACKOFF_BASE_MS * 2 ** (n - 1) * (0.5 + random() / 2))
      }
      const response = await attempt(path, body)
      if (response === undefined) {
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw unavailable()
      }
      const parsed = schema.safeParse(await response.json().catch(() => undefined))
      if (!parsed.success) {
        throw unavailable()
      }
      return parsed.data
    }
    throw unavailable()
  }

  return {
    membershipOf: async (organizationId, userId) => {
      const answer = await call(
        '/internal/v1/directory/membership',
        { organizationId, userId },
        internalDirectoryMembershipResponseSchema
      )
      // A suspended or deleted Organization has no usable Membership: not a member.
      return answer.found && answer.organizationStatus === 'active'
        ? answer.membershipId
        : undefined
    },
    teamRepsOf: async (organizationId, membershipId) =>
      (
        await call(
          '/internal/v1/directory/team-reps',
          { organizationId, membershipId },
          internalDirectoryTeamRepsResponseSchema
        )
      ).membershipIds,
    isRep: async (organizationId, membershipId) =>
      (
        await call(
          '/internal/v1/directory/rep-check',
          { organizationId, membershipId },
          internalDirectoryRepCheckResponseSchema
        )
      ).isRep,
    teamExists: async (organizationId, teamId) =>
      (
        await call(
          '/internal/v1/directory/team-check',
          { organizationId, teamId },
          internalDirectoryTeamCheckResponseSchema
        )
      ).exists,
  }
}
