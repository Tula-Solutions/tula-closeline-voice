import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { RecordingStore } from '~/ports/recording-store'

/** A fresh Organization id. */
export const newOrganizationId = (): string => formatId('org', crypto.randomUUID())

/** What a run needs: the store and a way to make a Call (a stored one, where a Call row is required). */
export type RecordingStoreHarness = {
  store: RecordingStore
  newCall: (organizationId: string) => Promise<ReturnType<typeof newCallId>>
}

/** A fresh Call id. */
export const newCallId = () => formatId('call', crypto.randomUUID())

const T0 = new Date('2026-01-01T00:00:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

/** The behaviour every {@link RecordingStore} must show, run against each adapter. */
export function recordingStoreBehaviour(name: string, make: () => RecordingStoreHarness): void {
  describe(`RecordingStore (${name})`, () => {
    test('begin creates one storing Recording per Call with a fixed key', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const callId = await newCall(org)
      const first = await store.begin(org, callId, at(0))
      const again = await store.begin(org, callId, at(5))
      expect(again).toEqual(first)
      expect(first).toMatchObject({ callId, state: 'storing', sizeBytes: null })
      expect(first.storageKey).toBe(`recordings/${callId}.wav`)
    })

    test('markStored succeeds once; later callers lose', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const callId = await newCall(org)
      await store.begin(org, callId, at(0))
      const results = await Promise.all([
        store.markStored(org, callId, { sizeBytes: 10, at: at(1) }),
        store.markStored(org, callId, { sizeBytes: 10, at: at(1) }),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await store.get(org, callId)).toMatchObject({ state: 'stored', sizeBytes: 10 })
      expect((await store.states(org, [callId])).get(callId)).toBe('stored')
    })

    test('another Organization sees and changes nothing', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const callId = await newCall(org)
      await store.begin(org, callId, at(0))
      await store.markStored(org, callId, { sizeBytes: 1, at: at(1) })
      const other = newOrganizationId()
      expect(await store.get(other, callId)).toBeUndefined()
      expect((await store.states(other, [callId])).size).toBe(0)
      expect(
        await store.markDeleted(other, callId, { at: at(2), purgeDueAt: at(3) })
      ).toBeUndefined()
      expect((await store.get(org, callId))?.state).toBe('stored')
    })

    test('markDeleted schedules the purge once, and a repeat keeps the first time', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const callId = await newCall(org)
      await store.begin(org, callId, at(0))
      await store.markStored(org, callId, { sizeBytes: 1, at: at(1) })
      const first = await store.markDeleted(org, callId, { at: at(2), purgeDueAt: at(100) })
      const second = await store.markDeleted(org, callId, { at: at(50), purgeDueAt: at(900) })
      expect(first).toMatchObject({ state: 'deleted', purgeDueAt: at(100) })
      expect(second).toEqual(first)
    })

    test('a deleted Recording is due only after its purge time, and finishing ends it', async () => {
      const { store, newCall } = make()
      const org = newOrganizationId()
      const callId = await newCall(org)
      await store.begin(org, callId, at(0))
      await store.markDeleted(org, callId, { at: at(1), purgeDueAt: at(100) })
      expect(await store.due(org, at(99), 10)).toEqual([])
      expect((await store.organizationsWithDue(at(99), null, 500)).includes(org)).toBe(false)
      expect((await store.due(org, at(100), 10)).map((r) => r.callId)).toEqual([callId])
      expect((await store.organizationsWithDue(at(100), null, 500)).includes(org)).toBe(true)
      await store.finishPurge(org, callId)
      expect(await store.due(org, at(1000), 10)).toEqual([])
      expect(await store.get(org, callId)).toMatchObject({ state: 'deleted', purgeDueAt: null })
    })
  })
}
