import { afterAll, describe, expect, test } from 'bun:test'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import {
  type CallCursor,
  CallKeyTakenError,
  type CallStore,
  InvalidTransitionError,
  type NewCall,
} from '~/ports/call-store'
import { createPostgresAgentTurnStore } from './agent-turn-store'
import { createPostgresCallStore } from './call-store'
import { createPostgresLineStore } from './line-store'

const { db, close } = createDb(integrationUrls().service)
const calls: CallStore = createPostgresCallStore(db)
const lines = createPostgresLineStore(db)
const turns = createPostgresAgentTurnStore(db)

afterAll(close)

const newOrganization = (): OrganizationId => formatId('org', crypto.randomUUID())
const T0 = new Date('2026-01-01T00:00:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

/** Inserts a Line (a Call refers to one) and returns a Call for it. */
async function callFor(org: OrganizationId, overrides: Partial<NewCall> = {}): Promise<NewCall> {
  const line = await lines.insert(org, {
    id: formatId('line', crypto.randomUUID()),
    number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: T0,
  })
  return {
    id: formatId('call', crypto.randomUUID()),
    lineId: line.id,
    repMembershipId: formatId('mem', crypto.randomUUID()),
    prospectId: null,
    prospectNumber: '+14155550100',
    createdAt: T0,
    ...overrides,
  }
}

describe('the Postgres Call store', () => {
  test('stores the Copilot setting at place time', async () => {
    const org = newOrganization()
    const on = await calls.insert(org, await callFor(org, { copilot: true }))
    const off = await calls.insert(org, await callFor(org))
    expect((await calls.get(org, on.id))?.copilot).toBe(true)
    expect((await calls.get(org, off.id))?.copilot).toBe(false)
  })

  test('marks the Transcript unavailable, for its own Organization only', async () => {
    const org = newOrganization()
    const other = newOrganization()
    const call = await calls.insert(org, await callFor(org))
    expect((await calls.get(org, call.id))?.transcriptUnavailable).toBeNull()
    await calls.markTranscriptUnavailable(other, call.id, 'stream_dropped')
    expect((await calls.get(org, call.id))?.transcriptUnavailable).toBeNull()
    await calls.markTranscriptUnavailable(org, call.id, 'speech_to_text_failed')
    expect((await calls.get(org, call.id))?.transcriptUnavailable).toBe('speech_to_text_failed')
  })

  test('fails stale outbound Calls by their state, for their own Organization only', async () => {
    const org = newOrganization()
    const other = newOrganization()
    const ringing = await calls.insert(org, await callFor(org))
    const connecting = await calls.insert(org, await callFor(org))
    await calls.transition(org, connecting.id, { to: 'connecting', at: at(1) })
    const fresh = await calls.insert(org, await callFor(org, { createdAt: at(100) }))
    const foreign = await calls.insert(other, await callFor(other))
    const found = await calls.organizationsWithStaleOutbound(at(30), null, 500)
    expect(found).toContain(org)
    const failed = await calls.failStaleOutbound(org, at(30), at(31), 100)
    const reasons = Object.fromEntries(failed.map((call) => [call.id, call.failureReason]))
    expect(reasons).toEqual({ [ringing.id]: 'no_answer', [connecting.id]: 'provider_error' })
    expect(await calls.failStaleOutbound(org, at(30), at(32), 100)).toEqual([])
    expect((await calls.get(org, ringing.id))?.state).toBe('failed')
    expect((await calls.get(org, fresh.id))?.state).toBe('ringing')
    expect((await calls.get(other, foreign.id))?.state).toBe('ringing')
  })

  test('inserts a ringing Call, reads it back and logs the first state', async () => {
    const org = newOrganization()
    const input = await callFor(org)
    const inserted = await calls.insert(org, input)
    expect(inserted.state).toBe('ringing')
    expect(await calls.get(org, input.id)).toEqual(inserted)
    expect((await calls.events(org, input.id)).map((e) => e.kind)).toEqual(['state_changed'])
  })

  test('walks to live only through a stored Disclosure, in order', async () => {
    const org = newOrganization()
    const input = await callFor(org)
    await calls.insert(org, input)
    await calls.setProviderCallSid(org, input.id, 'CA123')
    await calls.transition(org, input.id, { to: 'connecting', at: at(1) })
    await calls.transition(org, input.id, { to: 'disclosing', at: at(2) })
    await expect(calls.transition(org, input.id, { to: 'live', at: at(3) })).rejects.toBeInstanceOf(
      InvalidTransitionError
    )
    await calls.recordDisclosure(org, input.id, {
      wordingVersion: 1,
      aiAssisted: false,
      playedAt: at(3),
    })
    await calls.recordRecordingStarted(org, input.id, at(4))
    const live = await calls.transition(org, input.id, { to: 'live', at: at(5) })
    expect(live?.state).toBe('live')
    expect(live?.disclosure.wordingVersion).toBe(1)
    const kinds = (await calls.events(org, input.id)).map((e) => e.kind)
    expect(kinds.indexOf('disclosure_played')).toBeLessThan(kinds.indexOf('recording_started'))
    const ended = await calls.transition(org, input.id, { to: 'ended', at: at(65), endedBy: 'rep' })
    expect(ended?.state).toBe('ended')
    const wrapped = await calls.wrapUp(org, input.id, { note: 'Booked a demo' })
    expect(wrapped?.note).toBe('Booked a demo')
  })

  test('refuses a second Call under the same idempotency key', async () => {
    const org = newOrganization()
    const idempotency = {
      key: crypto.randomUUID().replaceAll('-', '').repeat(2),
      fingerprint: 'f'.repeat(64),
    }
    await calls.insert(org, await callFor(org, { idempotency }))
    await expect(calls.insert(org, await callFor(org, { idempotency }))).rejects.toBeInstanceOf(
      CallKeyTakenError
    )
  })

  test('shows another Organization nothing', async () => {
    const org = newOrganization()
    const input = await callFor(org)
    await calls.insert(org, input)
    const other = newOrganization()
    expect(await calls.get(other, input.id)).toBeUndefined()
    expect(await calls.list(other, { limit: 10 })).toEqual([])
  })

  test('pages newest first by keyset and filters by Rep', async () => {
    const org = newOrganization()
    const mine = formatId('mem', crypto.randomUUID())
    const ids: string[] = []
    for (const [second, rep] of [
      [1, mine],
      [2, undefined],
      [3, mine],
      [3, undefined],
    ] as const) {
      const input = await callFor(org, {
        createdAt: at(second),
        ...(rep ? { repMembershipId: rep } : {}),
      })
      ids.push((await calls.insert(org, input)).id)
    }
    const seen: string[] = []
    let cursor: CallCursor | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const rows = await calls.list(org, { limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...rows.map((r) => r.id))
      const last = rows.at(-1)
      if (rows.length < 2 || !last) {
        break
      }
      cursor = { createdAt: last.createdAt, id: last.id }
    }
    expect(seen.sort()).toEqual([...ids].sort())
    const own = await calls.list(org, { limit: 10, repMembershipIds: [mine] })
    expect(own).toHaveLength(2)
    expect(await calls.list(org, { limit: 10, repMembershipIds: [] })).toEqual([])
  })

  test('an inbound insert is once per provider call id, and a repeat finds the first', async () => {
    const org = newOrganization()
    const base = await callFor(org)
    const input = {
      id: base.id,
      lineId: base.lineId,
      repMembershipId: null,
      callerNumber: '+14155550123',
      providerCallSid: `CA${crypto.randomUUID().replaceAll('-', '')}`,
      createdAt: T0,
    }
    const first = await calls.insertInbound(org, input)
    const again = await calls.insertInbound(org, {
      ...input,
      id: formatId('call', crypto.randomUUID()),
    })
    expect(first.created).toBe(true)
    expect(first.call).toMatchObject({ direction: 'inbound', state: 'ringing' })
    expect(again.created).toBe(false)
    expect(again.call.id).toBe(first.call.id)
    expect((await calls.events(org, first.call.id)).map((e) => e.kind)).toEqual(['state_changed'])
  })

  test('of many simultaneous claims of an inbound Call exactly one wins', async () => {
    const org = newOrganization()
    const base = await callFor(org)
    const { call } = await calls.insertInbound(org, {
      id: base.id,
      lineId: base.lineId,
      repMembershipId: null,
      callerNumber: '+14155550123',
      providerCallSid: `CA${crypto.randomUUID().replaceAll('-', '')}`,
      createdAt: T0,
    })
    const reps = Array.from({ length: 8 }, () => formatId('mem', crypto.randomUUID()))
    const results = await Promise.all(
      reps.map((rep) => calls.claimInbound(org, call.id, rep, at(1)))
    )
    const winners = results.filter((result) => result !== undefined)
    expect(winners).toHaveLength(1)
    const stored = await calls.get(org, call.id)
    expect(stored).toMatchObject({
      state: 'connecting',
      repMembershipId: winners[0]?.repMembershipId,
    })
    expect(
      (await calls.events(org, call.id)).map((e) =>
        e.kind === 'state_changed' ? e.toState : e.kind
      )
    ).toEqual(['ringing', 'connecting'])
  })

  test('a claim by another Rep of a Call assigned to one, or of a missed Call, loses', async () => {
    const org = newOrganization()
    const base = await callFor(org)
    const mine = formatId('mem', crypto.randomUUID())
    const { call } = await calls.insertInbound(org, {
      id: base.id,
      lineId: base.lineId,
      repMembershipId: mine,
      callerNumber: '+14155550123',
      providerCallSid: `CA${crypto.randomUUID().replaceAll('-', '')}`,
      createdAt: T0,
    })
    expect(
      await calls.claimInbound(org, call.id, formatId('mem', crypto.randomUUID()), at(1))
    ).toBe(undefined)
    await calls.transition(org, call.id, { to: 'missed', at: at(2) })
    expect(await calls.claimInbound(org, call.id, mine, at(3))).toBe(undefined)
    expect(await calls.claimInbound(newOrganization(), call.id, mine, at(3))).toBe(undefined)
  })
  test('the missed sweep finds Organizations by the scan and misses only stale ringing Calls', async () => {
    const org = newOrganization()
    const other = newOrganization()
    const make = async (organization: OrganizationId, createdAt: Date) => {
      const base = await callFor(organization)
      const { call } = await calls.insertInbound(organization, {
        id: base.id,
        lineId: base.lineId,
        repMembershipId: null,
        callerNumber: '+14155550123',
        providerCallSid: `CA${crypto.randomUUID().replaceAll('-', '')}`,
        createdAt,
      })
      return call
    }
    const stale = await make(org, T0)
    const claimed = await make(org, T0)
    const fresh = await make(org, at(100))
    const foreign = await make(other, T0)
    await calls.claimInbound(org, claimed.id, formatId('mem', crypto.randomUUID()), at(1))

    const found: string[] = []
    let after: string | null = null
    for (;;) {
      const page: string[] = await calls.organizationsWithStaleRinging(at(30), after, 500)
      found.push(...page)
      after = page[page.length - 1] ?? null
      if (page.length < 500) {
        break
      }
    }
    expect(found).toContain(org)

    const missed = await calls.missStaleRinging(org, at(30), at(31), 100)
    expect(missed.map((call) => call.id)).toEqual([stale.id])
    expect(await calls.missStaleRinging(org, at(30), at(32), 100)).toEqual([])
    expect((await calls.get(org, stale.id))?.state).toBe('missed')
    expect((await calls.get(org, claimed.id))?.state).toBe('connecting')
    expect((await calls.get(org, fresh.id))?.state).toBe('ringing')
    expect((await calls.get(other, foreign.id))?.state).toBe('ringing')
    expect(
      (await calls.events(org, stale.id)).map((e) =>
        e.kind === 'state_changed' ? e.toState : e.kind
      )
    ).toEqual(['ringing', 'missed'])
  })
  /** An inbound Call no Rep holds, still ringing. */
  async function ringingForAgent(org: OrganizationId) {
    const base = await callFor(org)
    const { call } = await calls.insertInbound(org, {
      id: base.id,
      lineId: base.lineId,
      repMembershipId: null,
      callerNumber: '+14155550123',
      providerCallSid: `CA${crypto.randomUUID().replaceAll('-', '')}`,
      createdAt: T0,
    })
    return call
  }

  test('of many simultaneous Agent claims exactly one wins, and a Rep-held Call is never the Agent’s', async () => {
    const org = newOrganization()
    const call = await ringingForAgent(org)
    const results = await Promise.all(
      Array.from({ length: 8 }, () => calls.claimForAgent(org, call.id, at(1)))
    )
    expect(results.filter((result) => result !== undefined)).toHaveLength(1)
    const base = await callFor(org)
    const held = await calls.insertInbound(org, {
      id: base.id,
      lineId: base.lineId,
      repMembershipId: formatId('mem', crypto.randomUUID()),
      callerNumber: '+14155550124',
      providerCallSid: `CA${crypto.randomUUID().replaceAll('-', '')}`,
      createdAt: T0,
    })
    expect(await calls.claimForAgent(org, held.call.id, at(1))).toBeUndefined()
    expect(await calls.claimForAgent(newOrganization(), call.id, at(1))).toBeUndefined()
  })

  test('an Agent Call cannot go live on a Disclosure that did not say an AI speaks, and stores its end reason', async () => {
    const org = newOrganization()
    const call = await ringingForAgent(org)
    await calls.claimForAgent(org, call.id, at(1))
    await calls.transition(org, call.id, { to: 'disclosing', at: at(2) })
    await calls.recordDisclosure(org, call.id, {
      wordingVersion: 1,
      aiAssisted: false,
      playedAt: at(3),
    })
    await expect(
      calls.transition(org, call.id, { to: 'live', at: at(4), agent: true })
    ).rejects.toBeInstanceOf(InvalidTransitionError)
    expect((await calls.get(org, call.id))?.state).toBe('disclosing')

    const other = await ringingForAgent(org)
    await calls.claimForAgent(org, other.id, at(1))
    await calls.transition(org, other.id, { to: 'disclosing', at: at(2) })
    await calls.recordDisclosure(org, other.id, {
      wordingVersion: 2,
      aiAssisted: true,
      playedAt: at(3),
    })
    await expect(
      calls.transition(org, other.id, { to: 'live', at: at(4), endReason: 'cost_cap' })
    ).rejects.toBeInstanceOf(InvalidTransitionError)
    await calls.transition(org, other.id, { to: 'live', at: at(4), agent: true })
    const ended = await calls.transition(org, other.id, {
      to: 'ended',
      at: at(9),
      endedBy: 'system',
      endReason: 'duration_cap',
    })
    expect(ended).toMatchObject({ state: 'ended', endReason: 'duration_cap' })
    expect((await calls.get(org, other.id))?.endReason).toBe('duration_cap')
  })

  test('a turn adds its cost to the Call once, even when stored twice or at the same time', async () => {
    const org = newOrganization()
    const call = await ringingForAgent(org)
    const conversation = { kind: 'call', id: call.id } as const
    const turn = (index: number) => ({
      index,
      role: 'agent' as const,
      text: `turn ${index}`,
      deferred: false,
      toolName: null,
      sources: [],
    })
    const first = await turns.append(org, conversation, turn(1), 700)
    expect(first).toMatchObject({ created: true, callCostMicroCents: 700 })
    const replay = await turns.append(org, conversation, turn(1), 700)
    expect(replay).toMatchObject({ created: false, callCostMicroCents: null })
    const racers = await Promise.all(
      Array.from({ length: 6 }, () => turns.append(org, conversation, turn(3), 100))
    )
    expect(racers.filter((racer) => racer.created)).toHaveLength(1)
    expect((await calls.get(org, call.id))?.agentCostMicroCents).toBe(800)
    // Another Organization cannot store a turn on, or add cost to, this Call.
    await expect(turns.append(newOrganization(), conversation, turn(5), 999)).rejects.toThrow()
    expect((await calls.get(org, call.id))?.agentCostMicroCents).toBe(800)
  })
})
