import { beforeEach, describe, expect, it } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createMemoryTelephony, type MemoryTelephony } from 'tula-closeline-kit/testing'
import { sweepMissed } from '~/modules/call/missed-sweep'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

const BASE = 'http://voice.test'
const CALLER = '+14155550123'

type CallBody = { id: string; state: string; prospectNumber: string; direction: string }
type PageBody = { items: CallBody[] }

let t: TestApp
let telephony: MemoryTelephony
let organizationId: ReturnType<typeof newOrganizationId>
let admin: TestIdentity

type Party = { identity: TestIdentity; membership: string }

const partyIn = (org: typeof organizationId, role: 'rep' | 'manager' = 'rep'): Party => {
  const identity = identityOf(role, org)
  const membership = formatId('mem', crypto.randomUUID())
  t.deps.directory.addMembership(org, identity.userId, membership)
  t.deps.directory.addRep(org, membership)
  return { identity, membership }
}

/** Buys a Line in the Organization, assigns it, and returns its number. */
async function lineWith(
  org: typeof organizationId,
  assignment: Record<string, string>
): Promise<string> {
  const who = identityOf('admin', org)
  const bought = await t.call(who, 'POST', '/lines', { method: 'buy', country: 'US' })
  const line = bought.body as { id: string; number: string }
  const assigned = await t.call(who, 'PUT', `/lines/${line.id}/assignment`, assignment)
  expect(assigned.status).toBe(200)
  return line.number
}

/** Delivers the provider's inbound-call webhook, signed, as a Prospect calling `to`. */
async function ring(to: string, org = organizationId, sid?: string, signed = true) {
  const providerCallId = sid ?? telephony.receiveInbound(org, CALLER, to)
  const path = '/webhooks/twilio/inbound'
  const body = new URLSearchParams({ CallSid: providerCallId, From: CALLER, To: to }).toString()
  const response = await t.app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signed ? telephony.sign(`${BASE}${path}`, body) : 'AAAA',
    },
    body,
  })
  return { response, providerCallId }
}

/** Lets the ring time pass and runs one missed-Call sweep, as the schedule would after a restart. */
async function sweep(after = '31s') {
  t.deps.clock.advance(after)
  return sweepMissed(t.deps, { maxOrganizations: 100, shouldStop: () => false })
}

const answer = (who: TestIdentity, callId: string) => t.call(who, 'POST', `/calls/${callId}/answer`)
const callsOf = async (org = organizationId) =>
  (await t.deps.calls.list(org, { limit: 50 })) as unknown as CallBody[]
const listed = async (who: TestIdentity, query = '') =>
  ((await t.call(who, 'GET', `/calls${query}`)).body as PageBody).items

beforeEach(async () => {
  telephony = createMemoryTelephony()
  t = await createTestApp({ telephony, env: { WEBHOOK_BASE_URL: BASE } })
  organizationId = newOrganizationId()
  admin = identityOf('admin', organizationId)
})

describe('an inbound Call to a Line assigned to a Rep', () => {
  it('rings the Rep, and the Rep answers: Disclosure, then bridge, then live', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    const { response } = await ring(number)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/xml')
    const [call] = await callsOf()
    expect(call?.state).toBe('ringing')

    const answered = await answer(rep.identity, call?.id as string)
    expect(answered.status).toBe(200)
    expect((answered.body as CallBody).state).toBe('live')
    const order = telephony.operations.map((entry) => entry.operation)
    expect(order.indexOf('playDisclosure')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('playDisclosure')).toBeLessThan(order.indexOf('bridge'))
    expect(order.indexOf('bridge')).toBeLessThan(order.indexOf('startRecording'))
  })

  it('records a missed Call with the caller number when nobody answers, for that Rep only', async () => {
    const rep = partyIn(organizationId)
    const other = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    await ring(number)
    await sweep()

    const mine = await listed(rep.identity, '?state=missed')
    expect(mine).toHaveLength(1)
    expect(mine[0]?.prospectNumber).toBe(CALLER)
    expect(mine[0]?.direction).toBe('inbound')
    expect(await listed(other.identity, '?state=missed')).toHaveLength(0)
    expect(await listed(admin, '?state=missed')).toHaveLength(1)
  })

  it('does not miss a Call that was answered before the sweep runs', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    await ring(number)
    const [call] = await callsOf()
    await answer(rep.identity, call?.id as string)
    await sweep()
    expect((await callsOf())[0]?.state).toBe('live')
  })

  it('does not miss a Call a Rep has claimed but not yet bridged when the sweep runs', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    await ring(number)
    const [call] = await callsOf()
    await t.deps.calls.claimInbound(organizationId, call?.id as never, rep.membership, new Date())
    await sweep()
    expect((await callsOf())[0]?.state).toBe('connecting')
  })

  it('misses a Call by the database alone: no timer, no memory of the ring', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    await ring(number)
    expect(await sweep('5s')).toBe(0)
    expect((await callsOf())[0]?.state).toBe('ringing')
    expect(await sweep('30s')).toBe(1)
    expect((await callsOf())[0]?.state).toBe('missed')
    expect(telephony.operations.filter((entry) => entry.operation === 'hangUp')).toHaveLength(1)
  })

  it('is harmless to sweep twice: one miss, one hang-up', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    await ring(number)
    expect(await sweep()).toBe(1)
    expect(await sweep('1m')).toBe(0)
    expect(telephony.operations.filter((entry) => entry.operation === 'hangUp')).toHaveLength(1)
  })

  it('leaves another Organization alone when it sweeps only what is stale', async () => {
    const orgB = newOrganizationId()
    const repA = partyIn(organizationId)
    const repB = partyIn(orgB)
    const numberA = await lineWith(organizationId, { kind: 'rep', membershipId: repA.membership })
    await ring(numberA)
    t.deps.clock.advance('31s')
    const numberB = await lineWith(orgB, { kind: 'rep', membershipId: repB.membership })
    await ring(numberB, orgB)
    expect(await sweep('0s')).toBe(1)
    expect((await callsOf())[0]?.state).toBe('missed')
    expect((await callsOf(orgB))[0]?.state).toBe('ringing')
  })

  it('keeps sweeping the other Organizations when one Organization fails', async () => {
    const orgB = newOrganizationId()
    const repA = partyIn(organizationId)
    const repB = partyIn(orgB)
    await ring(await lineWith(organizationId, { kind: 'rep', membershipId: repA.membership }))
    await ring(await lineWith(orgB, { kind: 'rep', membershipId: repB.membership }), orgB)
    t.deps.clock.advance('31s')
    let failed = 0
    const calls = Object.create(t.deps.calls) as typeof t.deps.calls
    calls.missStaleRinging = (org, ...rest) => {
      if (failed === 0) {
        failed += 1
        return Promise.reject(new Error('boom'))
      }
      return t.deps.calls.missStaleRinging(org, ...rest)
    }
    const missed = await sweepMissed(
      { ...t.deps, calls },
      { maxOrganizations: 100, shouldStop: () => false }
    )
    expect(missed).toBe(1)
    const states = [...(await callsOf()), ...(await callsOf(orgB))].map((call) => call.state)
    expect(states.sort()).toEqual(['missed', 'ringing'])
  })

  it('answering again as the Rep who holds the Call is a no-op: 200, nothing runs twice', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    await ring(number)
    const [call] = await callsOf()
    const first = await answer(rep.identity, call?.id as string)
    const before = telephony.operations.length
    const again = await answer(rep.identity, call?.id as string)
    expect(again.status).toBe(200)
    expect((again.body as CallBody).id).toBe((first.body as CallBody).id)
    expect(telephony.operations.length).toBe(before)
  })

  it('records and rings once when the provider redelivers the webhook', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    const first = await ring(number)
    const again = await ring(number, organizationId, first.providerCallId)
    expect(again.response.status).toBe(200)
    expect(await callsOf()).toHaveLength(1)
    expect(telephony.operations.filter((entry) => entry.operation === 'answerCall')).toHaveLength(1)
  })

  it('refuses a bad signature and changes nothing', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    const { response } = await ring(number, organizationId, undefined, false)
    expect(response.status).toBe(403)
    expect(await callsOf()).toHaveLength(0)
  })

  it('ignores a number that is no Line', async () => {
    const { response } = await ring('+14155550999')
    expect(response.status).toBe(200)
    expect(await callsOf()).toHaveLength(0)
  })

  it('never logs the caller number', async () => {
    const rep = partyIn(organizationId)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: rep.membership })
    await ring(number)
    await sweep()
    expect(t.deps.logLines.join('\n')).not.toContain(CALLER.slice(1))
  })
})

describe('an inbound Call to a Team Line', () => {
  it('rings the online Reps; two answering at once resolve to exactly one bridge', async () => {
    const team = formatId('team', crypto.randomUUID())
    t.deps.directory.addTeam(organizationId, team)
    const a = partyIn(organizationId)
    const b = partyIn(organizationId)
    t.deps.directory.setOnlineReps(organizationId, team, [a.membership, b.membership])
    const number = await lineWith(organizationId, { kind: 'team', teamId: team })
    await ring(number)
    const [call] = await callsOf()

    const [ra, rb] = await Promise.all([
      answer(a.identity, call?.id as string),
      answer(b.identity, call?.id as string),
    ])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    const loser = ra.status === 409 ? ra : rb
    expect((loser.body as { error: { code: string } }).error.code).toBe('call.not_ringing')
    expect(telephony.operations.filter((entry) => entry.operation === 'bridge')).toHaveLength(1)
    expect((await callsOf())[0]?.state).toBe('live')
  })

  it('does not let a Rep who is offline answer', async () => {
    const team = formatId('team', crypto.randomUUID())
    t.deps.directory.addTeam(organizationId, team)
    const online = partyIn(organizationId)
    const offline = partyIn(organizationId)
    t.deps.directory.setOnlineReps(organizationId, team, [online.membership])
    const number = await lineWith(organizationId, { kind: 'team', teamId: team })
    await ring(number)
    const [call] = await callsOf()
    expect((await answer(offline.identity, call?.id as string)).status).toBe(404)
  })

  it('is missed at once when no Rep is online', async () => {
    const team = formatId('team', crypto.randomUUID())
    t.deps.directory.addTeam(organizationId, team)
    const number = await lineWith(organizationId, { kind: 'team', teamId: team })
    await ring(number)
    expect((await callsOf())[0]?.state).toBe('missed')
  })
})

describe('Organization isolation', () => {
  it('never rings or lets answer a Rep of another Organization', async () => {
    const orgB = newOrganizationId()
    const repA = partyIn(organizationId)
    const repB = partyIn(orgB)
    const number = await lineWith(organizationId, { kind: 'rep', membershipId: repA.membership })
    await ring(number)
    const [call] = await callsOf()
    expect(await callsOf(orgB)).toHaveLength(0)
    expect((await answer(repB.identity, call?.id as string)).status).toBe(404)
    expect(await listed(repB.identity)).toHaveLength(0)
  })
})
