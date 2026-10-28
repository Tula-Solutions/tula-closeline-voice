import { beforeEach, describe, expect, test } from 'bun:test'
import { createFixedClock } from 'tula-closeline-kit'
import { createMemoryTelephony, type MemoryTelephony } from 'tula-closeline-kit/testing'
import {
  addLine,
  addProspect,
  askInternal,
  NOON_NEW_YORK,
  stepBody,
  unpause,
} from '~/modules/agent-call-request/support'
import { createTestApp, newOrganizationId, type TestApp } from '~/testing'
import { sweepDueAgentCalls, WINDOW_RETRY_MS } from './scheduler'

let telephony: MemoryTelephony
let t: TestApp
let org: string
let phones = 100

beforeEach(async () => {
  telephony = createMemoryTelephony()
  t = await createTestApp({ telephony })
  t.deps.clock = createFixedClock(NOON_NEW_YORK)
  org = newOrganizationId()
  await unpause(t, org as never)
})

/** Queues an Agent Call for a new Prospect on a new Line and returns its id. */
async function queue(timeZone: string | null = 'America/New_York') {
  const line = await addLine(t, org as never)
  const prospect = addProspect(t, org as never, {
    timeZone,
    phone: `+1212555${String(phones++).padStart(4, '0')}`,
  })
  return (await askInternal(t, org, stepBody(prospect, line))).body.id
}

const options = { maxPerPass: 10, shouldStop: () => false }
const stateOf = async (id: string) => (await t.deps.agentCalls.get(org, id))?.state

describe('the dial scheduler', () => {
  test('dials a queued Agent Call that is due, inside the window', async () => {
    const id = await queue()
    expect(await sweepDueAgentCalls(t.deps, options)).toBe(1)
    expect(await stateOf(id)).toBe('dialing')
    expect(await sweepDueAgentCalls(t.deps, options)).toBe(0)
  })

  test('puts a Prospect outside their calling window back for later without dialing', async () => {
    const id = await queue()
    t.deps.clock = createFixedClock('2026-01-06T04:00:00Z')
    expect(await sweepDueAgentCalls(t.deps, options)).toBe(0)
    const row = await t.deps.agentCalls.get(org, id)
    expect(row?.state).toBe('queued')
    expect(Date.parse(row?.retryAt ?? '')).toBe(
      Date.parse('2026-01-06T04:00:00Z') + WINDOW_RETRY_MS
    )
    expect(telephony.operations.map((o) => o.operation)).not.toContain('placeAgentCall')
  })

  test('looks at no more than the bound per pass and the rest wait for the next', async () => {
    const ids = [await queue(), await queue(), await queue()]
    expect(await sweepDueAgentCalls(t.deps, { ...options, maxPerPass: 2 })).toBe(2)
    expect(await sweepDueAgentCalls(t.deps, options)).toBe(1)
    const states = await Promise.all(ids.map(stateOf))
    expect(states.every((state) => state === 'dialing')).toBe(true)
  })

  test('one failing dial does not stop the others', async () => {
    const first = await queue()
    const second = await queue()
    telephony.failNext('placeAgentCall', 'telephony.unavailable' as never)
    await sweepDueAgentCalls(t.deps, options)
    const states = [await stateOf(first), await stateOf(second)]
    expect(states).toContain('dialing')
  })

  test('a row that cannot be dialed does not hold the head of the queue', async () => {
    for (let i = 0; i < 12; i++) {
      const line = await addLine(t, org as never)
      const prospect = addProspect(t, org as never, { phone: `+1212555${2000 + i}` })
      await askInternal(t, org, stepBody(prospect, line))
      // The number is lost after the request: the scheduler can never dial this row.
      t.deps.prospects.add(org as never, prospect, { phone: null, timeZone: null, visibleTo: [] })
    }
    const good = await queue()
    await sweepDueAgentCalls(t.deps, options)
    await sweepDueAgentCalls(t.deps, options)
    expect(await stateOf(good)).toBe('dialing')
  })

  test('stops when asked to', async () => {
    await queue()
    expect(await sweepDueAgentCalls(t.deps, { ...options, shouldStop: () => true })).toBe(0)
  })
})
