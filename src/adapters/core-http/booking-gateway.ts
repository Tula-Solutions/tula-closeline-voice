import { publicBookingConfirmationSchema, publicSlotPageSchema } from 'tula-closeline-contract'
import type { z } from 'zod'
import { BookingFailedError, type BookingGateway } from '~/ports/booking-gateway'

/** The longest one attempt at core may take, in milliseconds. */
export const CORE_BOOKING_TIMEOUT_MS = 3_000
/** Retries after a network error, timeout or 5xx, on top of the first attempt. */
export const CORE_BOOKING_RETRIES = 2
const BACKOFF_BASE_MS = 100

/** Who a Call's Prospect is, as core needs it to book. */
export type ProspectContact = { name: string; email: string; timeZone: string }

/** Options for {@link createCoreHttpBookingGateway}. */
export type CoreHttpBookingOptions = {
  /** Core's origin, for example `https://core.internal`. */
  baseUrl: string
  /** The Booking Type link token of an Organization, or `undefined` when it has none. A credential. */
  linkTokenOf: (organizationId: string) => string | undefined
  /** The Prospect's name, email and time zone, or `undefined` when they are not known. */
  contactOf: (organizationId: string, callId: string) => Promise<ProspectContact | undefined>
  timeoutMs?: number
  retries?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

/**
 * The gateway over core's public booking routes for the Organization's Booking Type link. Core
 * picks the Rep. Any failure (no link, no contact, 4xx, 5xx after the bounded retries, a body the
 * contract rejects) is a {@link BookingFailedError}. Booking retries are safe: the idempotency key
 * is sent on every attempt.
 */
export function createCoreHttpBookingGateway(options: CoreHttpBookingOptions): BookingGateway {
  const base = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? CORE_BOOKING_TIMEOUT_MS
  const retries = options.retries ?? CORE_BOOKING_RETRIES
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  async function attempt(url: string, init: RequestInit): Promise<Response | undefined> {
    try {
      const response = await doFetch(url, {
        ...init,
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
    url: string,
    init: RequestInit,
    schema: S
  ): Promise<z.output<S>> {
    for (let n = 0; n <= retries; n++) {
      if (n > 0) {
        await sleep(BACKOFF_BASE_MS * 2 ** (n - 1) * (0.5 + random() / 2))
      }
      const response = await attempt(url, init)
      if (response === undefined) {
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new BookingFailedError(`core answered ${response.status}`)
      }
      const parsed = schema.safeParse(await response.json().catch(() => undefined))
      if (!parsed.success) {
        throw new BookingFailedError('core answered an unexpected body')
      }
      return parsed.data
    }
    throw new BookingFailedError('core unreachable')
  }

  const linkOf = (organizationId: string): string => {
    const token = options.linkTokenOf(organizationId)
    if (token === undefined) {
      throw new BookingFailedError('no booking link')
    }
    return `${base}/v1/public/booking-types/${encodeURIComponent(token)}`
  }

  return {
    async slots(organizationId, window) {
      const query = new URLSearchParams({ from: window.from, to: window.to, limit: '100' })
      const page = await call(
        `${linkOf(organizationId)}/slots?${query}`,
        { method: 'GET', headers: { accept: 'application/json' } },
        publicSlotPageSchema
      )
      return page.items
    },
    async book(organizationId, input) {
      const contact = await options.contactOf(organizationId, input.callId)
      if (contact === undefined) {
        throw new BookingFailedError('no prospect contact')
      }
      const confirmation = await call(
        `${linkOf(organizationId)}/bookings`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': input.idempotencyKey,
          },
          body: JSON.stringify({ ...contact, startsAt: input.startsAt, website: '' }),
        },
        publicBookingConfirmationSchema
      )
      return { startsAt: confirmation.startsAt, endsAt: confirmation.endsAt }
    },
  }
}
