import { beforeEach, describe, expect, it } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

let t: TestApp
let org: ReturnType<typeof newOrganizationId>
let admin: TestIdentity
let rep: TestIdentity
let other: TestIdentity
let callId: ReturnType<typeof formatId>

const member = (who: TestIdentity): string => {
  const id = formatId('mem', crypto.randomUUID())
  t.deps.directory.addMembership(who.organizationId, who.userId, id)
  t.deps.directory.addRep(who.organizationId, id)
  return id
}

/** Makes the stored Call report a ready Transcript, as the Transcript pipeline will. */
function makeReady(state: 'ready' | 'pending' = 'ready') {
  const get = t.deps.calls.get.bind(t.deps.calls)
  t.deps.calls.get = async (o, id) => {
    const call = await get(o, id)
    return call && { ...call, transcriptState: state }
  }
}

const read = (who: TestIdentity, id: string, query = '') =>
  t.call(who, 'GET', `/calls/${id}/transcript${query}`)

beforeEach(async () => {
  t = await createTestApp()
  org = newOrganizationId()
  admin = identityOf('admin', org)
  rep = identityOf('rep', org)
  other = identityOf('rep', org)
  const mine = member(rep)
  member(other)
  callId = formatId('call', crypto.randomUUID())
  const line = (
    (await t.call(admin, 'POST', '/lines', { method: 'buy', country: 'US' })).body as { id: string }
  ).id
  await t.call(admin, 'PUT', `/lines/${line}/assignment`, { kind: 'rep', membershipId: mine })
  await t.deps.calls.insert(org, {
    id: callId as never,
    lineId: line as never,
    repMembershipId: mine as never,
    prospectId: null,
    prospectNumber: '+14155550100',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  } as never)
  for (let i = 0; i < 5; i++) {
    await t.deps.callTurns.append(org, callId, {
      track: i % 2 ? 'prospect' : 'rep',
      text: `turn ${i}`,
      startMs: i * 1000,
      endMs: i * 1000 + 500,
    })
  }
})

describe('GET /v1/calls/{id}/transcript', () => {
  it('reports a pending Transcript with no turns', async () => {
    const res = await read(rep, callId)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ callId, state: 'pending', items: [], nextCursor: null })
  })

  it('pages a ready Transcript in time order with a cursor', async () => {
    makeReady()
    const first = await read(rep, callId, '?limit=2')
    const a = first.body as { items: { text: string; speaker: string }[]; nextCursor: string }
    expect(a.items.map((i) => i.text)).toEqual(['turn 0', 'turn 1'])
    expect(a.items[1]?.speaker).toBe('prospect')
    const second = await read(rep, callId, `?limit=2&cursor=${a.nextCursor}`)
    const b = second.body as { items: { text: string }[]; nextCursor: string }
    expect(b.items.map((i) => i.text)).toEqual(['turn 2', 'turn 3'])
    const third = await read(rep, callId, `?limit=2&cursor=${b.nextCursor}`)
    expect(third.body).toMatchObject({ items: [{ text: 'turn 4' }], nextCursor: null })
  })

  it('rejects a bad cursor and an over-large limit', async () => {
    makeReady()
    expect((await read(rep, callId, '?cursor=not-a-cursor')).status).toBe(400)
    expect((await read(rep, callId, '?limit=1000')).status).toBe(400)
  })

  it('reports a deleted Recording as a deleted Transcript', async () => {
    makeReady()
    await t.deps.recordings.begin(org, callId as never, new Date())
    await t.deps.recordings.markDeleted(org, callId as never, {
      at: new Date(),
      purgeDueAt: new Date(),
    })
    expect((await read(rep, callId)).body).toMatchObject({ state: 'deleted', items: [] })
  })

  it('hides the Call from another Rep, another Organization and keeps Admin all', async () => {
    makeReady()
    const stranger = identityOf('admin', newOrganizationId())
    for (const who of [other, stranger]) {
      const res = await read(who, callId)
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ error: { code: 'call.not_found' } })
    }
    expect((await read(admin, callId)).status).toBe(200)
  })
})
