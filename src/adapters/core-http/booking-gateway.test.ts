import { expect, test } from 'bun:test'
import { BookingFailedError } from '~/ports/booking-gateway'
import { createCoreHttpBookingGateway } from './booking-gateway'

type Call = { url: string; method: string; headers: Headers; body: unknown }
const ORG = `org_${'a'.repeat(32)}`
const TOKEN = 'link-token-0123456789'
const START = '2026-03-02T15:00:00.000Z'
const END = '2026-03-02T15:30:00.000Z'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const slotPage = {
  items: [{ startsAt: START, endsAt: END }],
  nextCursor: null,
  bookingType: { name: 'Intro', lengthMinutes: 30, mode: 'phone' },
}
const confirmation = {
  id: `bkg_${'e'.repeat(32)}`,
  startsAt: START,
  endsAt: END,
  mode: 'phone',
  joinUrl: null,
  manageToken: 'm'.repeat(43),
}

/** A gateway over a scripted fetch: the last answer repeats. */
function setup(
  answers: Array<Response | (() => Response)>,
  options: { token?: string | undefined; contact?: boolean } = {}
) {
  const calls: Call[] = []
  const sleeps: number[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method),
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]
    return typeof next === 'function' ? next() : (next?.clone() as Response)
  }) as typeof fetch
  const gateway = createCoreHttpBookingGateway({
    baseUrl: 'http://core.test/',
    linkTokenOf: (org) => (org === ORG && !('token' in options) ? TOKEN : options.token),
    contactOf: async () =>
      options.contact === false
        ? undefined
        : { name: 'Pat', email: 'pat@example.test', timeZone: 'UTC' },
    fetch: fetcher,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
  })
  return { gateway, calls, sleeps }
}

const window = { from: START, to: '2026-03-16T15:00:00.000Z' }
const book = { callId: `call_${'f'.repeat(32)}`, startsAt: START, idempotencyKey: 'voice-book-1-1' }

test('slots reads the Booking Type link and returns the free times', async () => {
  const { gateway, calls } = setup([json(slotPage)])
  expect(await gateway.slots(ORG, window)).toEqual([{ startsAt: START, endsAt: END }])
  expect(calls[0]?.method).toBe('GET')
  expect(calls[0]?.url).toStartWith(`http://core.test/v1/public/booking-types/${TOKEN}/slots?`)
})

test('book posts the contact and time with the idempotency key', async () => {
  const { gateway, calls } = setup([json(confirmation, 201)])
  expect(await gateway.book(ORG, book)).toEqual({ startsAt: START, endsAt: END })
  expect(calls[0]?.headers.get('idempotency-key')).toBe('voice-book-1-1')
  expect(calls[0]?.body).toEqual({
    name: 'Pat',
    email: 'pat@example.test',
    timeZone: 'UTC',
    startsAt: START,
    website: '',
  })
})

test('a 5xx is retried with backoff, then succeeds', async () => {
  const { gateway, calls, sleeps } = setup([json({}, 503), json(slotPage)])
  expect(await gateway.slots(ORG, window)).toHaveLength(1)
  expect(calls).toHaveLength(2)
  expect(sleeps).toHaveLength(1)
})

test('a persistent 5xx fails after the bounded retries', async () => {
  const { gateway, calls } = setup([json({}, 503)])
  await expect(gateway.book(ORG, book)).rejects.toBeInstanceOf(BookingFailedError)
  expect(calls).toHaveLength(3)
})

test('a 409 (the time is taken) fails without a retry', async () => {
  const { gateway, calls } = setup([json({ code: 'booking.slot_taken' }, 409)])
  await expect(gateway.book(ORG, book)).rejects.toBeInstanceOf(BookingFailedError)
  expect(calls).toHaveLength(1)
})

test('an Organization with no link never reaches core', async () => {
  const { gateway, calls } = setup([json(slotPage)], { token: undefined })
  await expect(gateway.slots(ORG, window)).rejects.toBeInstanceOf(BookingFailedError)
  expect(calls).toHaveLength(0)
})

test('no Prospect contact means no booking request', async () => {
  const { gateway, calls } = setup([json(confirmation, 201)], { contact: false })
  await expect(gateway.book(ORG, book)).rejects.toBeInstanceOf(BookingFailedError)
  expect(calls).toHaveLength(0)
})

test('a body the contract rejects fails the booking', async () => {
  const { gateway } = setup([json({ nonsense: true }, 201)])
  await expect(gateway.book(ORG, book)).rejects.toBeInstanceOf(BookingFailedError)
})
