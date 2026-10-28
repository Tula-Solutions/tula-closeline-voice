import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { CallTurnStore, NewCallTurn } from '~/ports/call-turn-store'

/** A fresh Organization id. */
export const newOrganizationId = (): string => formatId('org', crypto.randomUUID())

const turn = (track: NewCallTurn['track'], startMs: number, text = `${track} ${startMs}`) => ({
  track,
  text,
  startMs,
  endMs: startMs + 500,
})

/** A store under test and a way to make a Call of an Organization that the store may refer to. */
export type CallTurnHarness = {
  store: CallTurnStore
  newCall: (organizationId: string) => Promise<string>
}

/** The behaviour every {@link CallTurnStore} must show, run against each adapter. */
export function callTurnStoreBehaviour(name: string, make: () => CallTurnHarness): void {
  describe(`CallTurnStore (${name})`, () => {
    test('numbers turns per track from 1 and lists them in time order', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      const a = await store.append(org, call, turn('rep', 0))
      const b = await store.append(org, call, turn('prospect', 400))
      const c = await store.append(org, call, turn('rep', 900))
      expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 1, 2])
      const all = await store.list(org, call, { rep: 0, prospect: 0 }, 10)
      expect(all.map((t) => [t.track, t.sequence])).toEqual([
        ['rep', 1],
        ['prospect', 1],
        ['rep', 2],
      ])
    })

    test('lists only what is after the cursor, and no more than the limit', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      for (const start of [0, 1000, 2000]) {
        await store.append(org, call, turn('rep', start))
      }
      await store.append(org, call, turn('prospect', 500))
      const rest = await store.list(org, call, { rep: 1, prospect: 1 }, 10)
      expect(rest.map((t) => t.startMs)).toEqual([1000, 2000])
      expect(await store.list(org, call, { rep: 0, prospect: 0 }, 2)).toHaveLength(2)
    })

    test('another Organization reads nothing of the Call', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const call = await newCall(org)
      await store.append(org, call, turn('rep', 0))
      expect(await store.list(newOrganizationId(), call, { rep: 0, prospect: 0 }, 10)).toEqual([])
    })
  })
}
