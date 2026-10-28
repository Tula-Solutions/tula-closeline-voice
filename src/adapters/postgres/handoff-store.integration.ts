import { afterAll, describe, expect, test } from 'bun:test'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresCallStore } from './call-store'
import { createPostgresHandoffStore } from './handoff-store'
import { createPostgresLineStore } from './line-store'

const { db, close } = createDb(integrationUrls().service)
const lines = createPostgresLineStore(db)
const calls = createPostgresCallStore(db)
const handoffs = createPostgresHandoffStore(db)

afterAll(close)

const t0 = new Date('2026-01-01T00:00:00.000Z')
const t1 = new Date('2026-01-01T00:00:05.000Z')
const t2 = new Date('2026-01-01T00:00:09.000Z')

/** The value, or a failure when a step that should have produced one did not. */
function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value')
  }
  return value
}

/** A new Call (and its Line) in the Organization. */
async function newCall(org: OrganizationId) {
  const line = await lines.insert(org, {
    id: formatId('line', crypto.randomUUID()),
    number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: t0,
  })
  const call = await calls.insert(org, {
    id: formatId('call', crypto.randomUUID()),
    lineId: line.id,
    repMembershipId: formatId('mem', crypto.randomUUID()),
    prospectId: null,
    prospectNumber: '+14155550100',
    createdAt: t0,
  })
  return call.id
}

describe('postgres handoff store', () => {
  test('offer, accept and complete store the timing; a live Handoff blocks a second offer', async () => {
    const org = formatId('org', crypto.randomUUID())
    const callId = await newCall(org)
    const rep = formatId('mem', crypto.randomUUID())
    const offer = { callId, repMembershipId: rep, attempt: 1, reason: 'asked_for_rep' as const }
    const first = must(await handoffs.offer(org, { ...offer, at: t0 }))
    expect(first.state).toBe('pending')
    expect(await handoffs.offer(org, { ...offer, attempt: 2, at: t0 })).toBeUndefined()
    const accepted = await handoffs.answer(org, first.id, rep, 'accepted', t1)
    expect(accepted?.answeredAt).toBe(t1.toISOString())
    const done = await handoffs.complete(org, first.id, 'bridged', t2)
    expect(done?.state).toBe('completed')
    expect(done?.completedAt).toBe(t2.toISOString())
    expect((await handoffs.forCall(org, callId)).map((h) => h.id)).toEqual([first.id])
  })

  test('decline, expire and no_rep rows', async () => {
    const org = formatId('org', crypto.randomUUID())
    const callId = await newCall(org)
    const a = formatId('mem', crypto.randomUUID())
    const base = { callId, reason: 'agent_unsure' as const, at: t0 }
    const one = must(await handoffs.offer(org, { ...base, repMembershipId: a, attempt: 1 }))
    expect((await handoffs.answer(org, one.id, a, 'declined', t1))?.state).toBe('declined')
    const two = must(await handoffs.offer(org, { ...base, repMembershipId: a, attempt: 2 }))
    expect((await handoffs.expire(org, two.id))?.state).toBe('timed_out')
    expect(await handoffs.expire(org, two.id)).toBeUndefined()
    const none = await handoffs.noRep(org, { callId, reason: 'agent_unsure', attempt: 3, at: t2 })
    expect(none.state).toBe('no_rep')
    expect(none.repMembershipId).toBeNull()
  })

  test('another Organization sees nothing and cannot answer', async () => {
    const org = formatId('org', crypto.randomUUID())
    const other = formatId('org', crypto.randomUUID())
    const callId = await newCall(org)
    const rep = formatId('mem', crypto.randomUUID())
    const h = must(
      await handoffs.offer(org, {
        callId,
        repMembershipId: rep,
        attempt: 1,
        reason: 'asked_for_rep',
        at: t0,
      })
    )
    expect(await handoffs.get(other, h.id)).toBeUndefined()
    expect(await handoffs.forCall(other, callId)).toEqual([])
    expect(await handoffs.answer(other, h.id, rep, 'accepted', t1)).toBeUndefined()
  })
})
