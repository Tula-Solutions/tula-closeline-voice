import { describe, expect, it } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { CallKeyTakenError, InvalidTransitionError, type NewCall } from '~/ports/call-store'
import { createMemoryCallStore } from './call-store'

const ORG = formatId('org', crypto.randomUUID())
const OTHER_ORG = formatId('org', crypto.randomUUID())
const T0 = new Date('2026-01-01T00:00:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

const newCall = (overrides: Partial<NewCall> = {}): NewCall => ({
  id: formatId('call', crypto.randomUUID()),
  lineId: formatId('line', crypto.randomUUID()),
  repMembershipId: formatId('mem', crypto.randomUUID()),
  prospectId: null,
  prospectNumber: '+14155550100',
  createdAt: T0,
  ...overrides,
})

describe('the memory Call store', () => {
  it('inserts a ringing Call and logs its first state', async () => {
    const store = createMemoryCallStore()
    const call = await store.insert(ORG, newCall())
    expect(call.state).toBe('ringing')
    expect(await store.events(ORG, call.id)).toEqual([
      { kind: 'state_changed', fromState: null, toState: 'ringing', at: T0 },
    ])
  })

  it('refuses live without a stored Disclosure, and allows it once one is stored', async () => {
    const store = createMemoryCallStore()
    const call = await store.insert(ORG, newCall())
    await store.transition(ORG, call.id, { to: 'connecting', at: at(1) })
    await store.transition(ORG, call.id, { to: 'disclosing', at: at(2) })
    await expect(store.transition(ORG, call.id, { to: 'live', at: at(3) })).rejects.toBeInstanceOf(
      InvalidTransitionError
    )
    await store.recordDisclosure(ORG, call.id, {
      wordingVersion: 1,
      aiAssisted: false,
      playedAt: at(3),
    })
    await store.recordRecordingStarted(ORG, call.id, at(4))
    const live = await store.transition(ORG, call.id, { to: 'live', at: at(5) })
    expect(live?.state).toBe('live')
    const kinds = (await store.events(ORG, call.id)).map((entry) => entry.kind)
    expect(kinds.indexOf('disclosure_played')).toBeLessThan(kinds.indexOf('recording_started'))
  })

  it('fails a Call only with a reason', async () => {
    const store = createMemoryCallStore()
    const call = await store.insert(ORG, newCall())
    await expect(
      store.transition(ORG, call.id, { to: 'failed', at: at(1) })
    ).rejects.toBeInstanceOf(InvalidTransitionError)
    const failed = await store.transition(ORG, call.id, {
      to: 'failed',
      at: at(1),
      failureReason: 'timeout',
    })
    expect(failed?.failureReason).toBe('timeout')
  })

  it('refuses a stored Disclosure outside disclosing', async () => {
    const store = createMemoryCallStore()
    const call = await store.insert(ORG, newCall())
    await expect(
      store.recordDisclosure(ORG, call.id, {
        wordingVersion: 1,
        aiAssisted: false,
        playedAt: at(1),
      })
    ).rejects.toBeInstanceOf(InvalidTransitionError)
  })

  it('refuses a second Call under the same idempotency key', async () => {
    const store = createMemoryCallStore()
    const idempotency = { key: 'a'.repeat(64), fingerprint: 'b'.repeat(64) }
    await store.insert(ORG, newCall({ idempotency }))
    await expect(store.insert(ORG, newCall({ idempotency }))).rejects.toBeInstanceOf(
      CallKeyTakenError
    )
  })

  it('marks the Transcript unavailable for its own Organization only', async () => {
    const store = createMemoryCallStore()
    const call = await store.insert(ORG, newCall())
    expect(call.transcriptUnavailable).toBeNull()
    await store.markTranscriptUnavailable(OTHER_ORG, call.id, 'stream_dropped')
    expect((await store.get(ORG, call.id))?.transcriptUnavailable).toBeNull()
    await store.markTranscriptUnavailable(ORG, call.id, 'stream_dropped')
    expect((await store.get(ORG, call.id))?.transcriptUnavailable).toBe('stream_dropped')
  })

  it('shows another Organization nothing', async () => {
    const store = createMemoryCallStore()
    const call = await store.insert(ORG, newCall())
    expect(await store.get(OTHER_ORG, call.id)).toBeUndefined()
    expect(await store.list(OTHER_ORG, { limit: 10 })).toEqual([])
    expect(
      await store.transition(OTHER_ORG, call.id, { to: 'connecting', at: at(1) })
    ).toBeUndefined()
  })

  it('lists newest first, filters by Rep and pages by cursor', async () => {
    const store = createMemoryCallStore()
    const mine = formatId('mem', crypto.randomUUID())
    const a = await store.insert(ORG, newCall({ repMembershipId: mine, createdAt: at(1) }))
    const b = await store.insert(ORG, newCall({ createdAt: at(2) }))
    const c = await store.insert(ORG, newCall({ repMembershipId: mine, createdAt: at(3) }))
    expect((await store.list(ORG, { limit: 10 })).map((x) => x.id)).toEqual([c.id, b.id, a.id])
    expect(
      (await store.list(ORG, { limit: 10, repMembershipIds: [mine] })).map((x) => x.id)
    ).toEqual([c.id, a.id])
    expect(await store.list(ORG, { limit: 10, repMembershipIds: [] })).toEqual([])
    const page = await store.list(ORG, { limit: 10, cursor: { createdAt: b.createdAt, id: b.id } })
    expect(page.map((x) => x.id)).toEqual([a.id])
  })

  it('keeps one inbound Call per provider call id', async () => {
    const store = createMemoryCallStore()
    const input = {
      id: formatId('call', crypto.randomUUID()),
      lineId: formatId('line', crypto.randomUUID()),
      repMembershipId: null,
      callerNumber: '+14155550123',
      providerCallSid: 'CA1',
      createdAt: T0,
    }
    const first = await store.insertInbound(ORG, input)
    const again = await store.insertInbound(ORG, {
      ...input,
      id: formatId('call', crypto.randomUUID()),
    })
    expect([first.created, again.created]).toEqual([true, false])
    expect(again.call.id).toBe(first.call.id)
    expect((await store.insertInbound(OTHER_ORG, input)).created).toBe(true)
  })

  it('lets exactly one of two claims of a ringing inbound Call win', async () => {
    const store = createMemoryCallStore()
    const { call } = await store.insertInbound(ORG, {
      id: formatId('call', crypto.randomUUID()),
      lineId: formatId('line', crypto.randomUUID()),
      repMembershipId: null,
      callerNumber: '+14155550123',
      providerCallSid: 'CA1',
      createdAt: T0,
    })
    const a = formatId('mem', crypto.randomUUID())
    const b = formatId('mem', crypto.randomUUID())
    const results = await Promise.all([
      store.claimInbound(ORG, call.id, a, at(1)),
      store.claimInbound(ORG, call.id, b, at(1)),
    ])
    expect(results.filter((r) => r !== undefined)).toHaveLength(1)
    expect(await store.claimInbound(OTHER_ORG, call.id, a, at(2))).toBe(undefined)
  })
  describe('the Agent answering', () => {
    const inbound = async (store: ReturnType<typeof createMemoryCallStore>, rep: string | null) => {
      const base = newCall()
      const { call } = await store.insertInbound(ORG, {
        id: base.id,
        lineId: base.lineId,
        repMembershipId: rep,
        callerNumber: '+14155550123',
        providerCallSid: `CA${crypto.randomUUID().replaceAll('-', '')}`,
        createdAt: T0,
      })
      return call
    }

    it('claims a ringing Call no Rep holds, once, and never one a Rep holds', async () => {
      const store = createMemoryCallStore()
      const call = await inbound(store, null)
      const claimed = await store.claimForAgent(ORG, call.id, at(1))
      expect(claimed).toMatchObject({ state: 'connecting', repMembershipId: null })
      expect(await store.claimForAgent(ORG, call.id, at(2))).toBeUndefined()
      const held = await inbound(store, formatId('mem', crypto.randomUUID()))
      expect(await store.claimForAgent(ORG, held.id, at(1))).toBeUndefined()
      expect(await store.claimForAgent(OTHER_ORG, call.id, at(1))).toBeUndefined()
    })

    it('goes live only after a Disclosure that says an AI is speaking', async () => {
      const store = createMemoryCallStore()
      const call = await inbound(store, null)
      await store.claimForAgent(ORG, call.id, at(1))
      await store.transition(ORG, call.id, { to: 'disclosing', at: at(2) })
      await store.recordDisclosure(ORG, call.id, {
        wordingVersion: 1,
        aiAssisted: false,
        playedAt: at(3),
      })
      await expect(
        store.transition(ORG, call.id, { to: 'live', at: at(4), agent: true })
      ).rejects.toBeInstanceOf(InvalidTransitionError)
      expect((await store.get(ORG, call.id))?.state).toBe('disclosing')
    })

    it('stores why a Call ended, and only on an ended Call', async () => {
      const store = createMemoryCallStore()
      const call = await store.insert(ORG, newCall())
      await store.transition(ORG, call.id, { to: 'connecting', at: at(1) })
      await store.transition(ORG, call.id, { to: 'disclosing', at: at(2) })
      await store.recordDisclosure(ORG, call.id, {
        wordingVersion: 2,
        aiAssisted: true,
        playedAt: at(3),
      })
      await expect(
        store.transition(ORG, call.id, { to: 'live', at: at(4), endReason: 'cost_cap' })
      ).rejects.toBeInstanceOf(InvalidTransitionError)
      await store.transition(ORG, call.id, { to: 'live', at: at(4), agent: true })
      const ended = await store.transition(ORG, call.id, {
        to: 'ended',
        at: at(9),
        endedBy: 'system',
        endReason: 'duration_cap',
      })
      expect(ended).toMatchObject({ state: 'ended', endReason: 'duration_cap', endedBy: 'system' })
    })
  })
})
