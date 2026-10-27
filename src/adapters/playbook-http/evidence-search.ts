import {
  ERRORS,
  searchDocumentsRequestSchema,
  searchDocumentsResponseSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { EvidenceSearch } from '~/ports/evidence-search'

/** The longest one attempt at the Playbook may take: a live chat turn cannot wait longer, in ms. */
export const PLAYBOOK_SEARCH_TIMEOUT_MS = 2_500
/** Retries after a timeout or a 503, on top of the first attempt (worst case about 5.3 s in all). */
export const PLAYBOOK_SEARCH_RETRIES = 1
/** The base of the exponential backoff between attempts, in milliseconds. */
const BACKOFF_BASE_MS = 100
/** The longest wait a `Retry-After` may ask for, in milliseconds. */
const MAX_RETRY_AFTER_MS = 500

/** Options for {@link createPlaybookHttpEvidenceSearch}. */
export type PlaybookHttpOptions = {
  /** The Playbook's origin, for example `https://playbook.internal`. */
  baseUrl: string
  /** The internal bearer secret (ADR 0013). Never logged. */
  token: string
  /** Per-attempt timeout; defaults to {@link PLAYBOOK_SEARCH_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Retries after a failed attempt; defaults to {@link PLAYBOOK_SEARCH_RETRIES}. */
  retries?: number
  /** The HTTP client; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Waits between attempts; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
  /** Jitter source in [0, 1); defaults to `Math.random`. */
  random?: () => number
}

const rethrowTimeout = (error: unknown): undefined => {
  if (error instanceof Error && error.name === 'TimeoutError') {
    throw error
  }
  return undefined
}

const fail = (code: 'server.unavailable' | 'server.timeout'): AppError =>
  new AppError({
    code: ERRORS[code].code,
    status: ERRORS[code].status,
    message: ERRORS[code].message,
  })

/**
 * Evidence search over the Playbook's internal Document search route. A timeout is
 * `server.timeout`; every other failure (network, 401, 400, 5xx, a body the contract rejects) is
 * `server.unavailable`, so the Agent fails closed. Only a client timeout, a network error and a 503
 * are retried (the search only reads); the Playbook's own 504 is not, because it already used its
 * budget. A 401 or 400 is our own fault, not the caller's, so it is never shown as one.
 */
export function createPlaybookHttpEvidenceSearch(options: PlaybookHttpOptions): EvidenceSearch {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/internal/v1/playbook/search/documents`
  const timeoutMs = options.timeoutMs ?? PLAYBOOK_SEARCH_TIMEOUT_MS
  const retries = options.retries ?? PLAYBOOK_SEARCH_RETRIES
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  /** One attempt: a response to use, or a retryable failure (with how long the server asked to wait). */
  async function attempt(
    organizationId: string,
    body: string
  ): Promise<{ status: number; data: unknown } | { retry: AppError; waitMs: number }> {
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'x-organization-id': organizationId,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 503) {
        await response.body?.cancel().catch(() => {})
        const seconds = Number(response.headers.get('retry-after'))
        const waitMs = Number.isFinite(seconds) ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS) : 0
        return { retry: fail('server.unavailable'), waitMs: Math.max(waitMs, 0) }
      }
      // Read the body here so a stall after the headers hits the same timeout and retry path.
      const data = response.status === 200 ? await response.json().catch(rethrowTimeout) : undefined
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})
      }
      return { status: response.status, data }
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return { retry: fail(timedOut ? 'server.timeout' : 'server.unavailable'), waitMs: 0 }
    }
  }

  return {
    async search(organizationId, turns, limit) {
      const request = searchDocumentsRequestSchema.safeParse({ turns, limit })
      if (!request.success) {
        throw fail('server.unavailable')
      }
      const body = JSON.stringify(request.data)
      let last = fail('server.unavailable')
      for (let n = 0; n <= retries; n++) {
        if (n > 0) {
          await sleep(BACKOFF_BASE_MS * 2 ** (n - 1) * (0.5 + random() / 2))
        }
        const result = await attempt(organizationId, body)
        if ('retry' in result) {
          last = result.retry
          if (result.waitMs > 0 && n < retries) {
            await sleep(result.waitMs)
          }
          continue
        }
        if (result.status === 504) {
          throw fail('server.timeout')
        }
        const parsed = searchDocumentsResponseSchema.safeParse(result.data)
        if (result.status !== 200 || !parsed.success) {
          throw fail('server.unavailable')
        }
        // shortcut: the Playbook has no internal Moments route yet, so none are returned; add the
        // call here when POST /internal/v1/playbook/search/moments exists.
        return { documents: parsed.data.items, moments: [] }
      }
      throw last
    },
  }
}
