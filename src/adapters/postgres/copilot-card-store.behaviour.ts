import { describe, expect, test } from 'bun:test'
import { type CallId, type DealRecordId, formatId } from 'tula-closeline-contract'
import type { CopilotCardStore, NewCard } from '~/ports/copilot-card-store'
import { newOrganizationId } from './call-turn-store.behaviour'

const at = (ms: number) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + ms)

const card = (shownAt: Date, cited = formatId('call', crypto.randomUUID())): NewCard => {
  const callId = cited as CallId
  const dealRecordId = formatId('deal', crypto.randomUUID()) as DealRecordId
  return {
    evidence: { moments: 3, deals: 2 },
    citedMoments: [{ callId, dealRecordId }],
    quotes: [{ callId, dealRecordId, prospect: 'Too expensive.', repNext: 'Fair, here is why.' }],
    shownAt,
  }
}

/** A store under test and a way to make a Call of an Organization that the store may refer to. */
export type CardHarness = {
  store: CopilotCardStore
  newCall: (organizationId: string) => Promise<string>
}

/** The behaviour every {@link CopilotCardStore} must show, run against each adapter. */
export function copilotCardStoreBehaviour(name: string, make: () => CardHarness): void {
  describe(`CopilotCardStore (${name})`, () => {
    test('numbers cards per Call from 1 and returns them whole', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      const other = await newCall(org)
      const a = await store.append(org, call, card(at(0)))
      const b = await store.append(org, call, card(at(9000)))
      const c = await store.append(org, other, card(at(0)))
      expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 1])
      expect(a).toMatchObject({
        kind: 'similar_moment',
        callId: call,
        evidence: { moments: 3, deals: 2 },
        shownAt: at(0).toISOString(),
        rating: null,
        dismissed: false,
        pinned: false,
      })
      expect(a.id).toStartWith('ccard_')
    })

    test('lists what is after the sequence, oldest first, no more than the limit', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      for (const ms of [0, 9000, 18000]) {
        await store.append(org, call, card(at(ms)))
      }
      expect((await store.list(org, call, 1, 10)).map((c) => c.sequence)).toEqual([2, 3])
      expect(await store.list(org, call, 0, 2)).toHaveLength(2)
    })

    test('tallies the count and the cards shown since a time', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      const first = card(at(0))
      await store.append(org, call, first)
      await store.append(org, call, card(at(30000)))
      const tally = await store.tally(org, call, at(10000))
      expect(tally.count).toBe(2)
      expect(tally.recent.map((r) => r.shownAt.getTime())).toEqual([at(30000).getTime()])
      expect(tally.recent[0]?.citedMoments).toHaveLength(1)
    })

    test('upgrades only a retrieval card, in place, and keeps its number and evidence', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      const first = card(at(0))
      const shown = await store.append(org, call, first)
      const composed = {
        kind: 'objection' as const,
        objectionType: 'price' as const,
        response: 'Show the payback in months.',
        citedMoments: first.citedMoments,
        quotes: first.quotes,
      }
      const upgraded = await store.upgrade(org, call, shown.id, composed)
      expect(upgraded).toMatchObject({
        kind: 'objection',
        objectionType: 'price',
        response: 'Show the payback in months.',
        id: shown.id,
        sequence: 1,
        evidence: { moments: 3, deals: 2 },
      })
      expect((await store.list(org, call, 0, 10))[0]).toEqual(upgraded)
      // Already upgraded, another Organization's, or unknown: nothing changes.
      expect(await store.upgrade(org, call, shown.id, composed)).toBeUndefined()
      expect(await store.upgrade(newOrganizationId(), call, shown.id, composed)).toBeUndefined()
    })

    test('stores a card with a Document source as a document card', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      const source = {
        documentId: formatId('doc', crypto.randomUUID()),
        page: 2,
        passage: 'The plan costs 10.',
      }
      const shown = await store.append(org, call, { ...card(at(0)), source } as NewCard)
      expect(shown).toMatchObject({ kind: 'document', source })
      expect((await store.list(org, call, 0, 10))[0]).toEqual(shown)
    })

    test('another Organization reads and counts nothing of the Call', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      await store.append(org, call, card(at(0)))
      const stranger = newOrganizationId()
      expect(await store.list(stranger, call, 0, 10)).toEqual([])
      expect((await store.tally(stranger, call, at(0))).count).toBe(0)
    })
  })
}
