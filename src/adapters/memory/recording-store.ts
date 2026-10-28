import type { RecordingStore, StoredRecording } from '~/ports/recording-store'
import { recordingKeyOf } from '~/ports/recording-store'

/** An in-memory {@link RecordingStore} for tests and local runs. */
export function createMemoryRecordingStore(): RecordingStore {
  const rows = new Map<string, StoredRecording & { organizationId: string }>()
  const keyOf = (organizationId: string, callId: string) => `${organizationId}:${callId}`
  const view = (row: StoredRecording & { organizationId: string }): StoredRecording => {
    const { organizationId: _organizationId, ...recording } = row
    return recording
  }

  return {
    async begin(organizationId, callId) {
      const key = keyOf(organizationId, callId)
      let row = rows.get(key)
      if (row === undefined) {
        row = {
          organizationId,
          callId,
          storageKey: recordingKeyOf(callId),
          sizeBytes: null,
          state: 'storing',
          purgeDueAt: null,
        }
        rows.set(key, row)
      }
      return view(row)
    },
    async markStored(organizationId, callId, stored) {
      const row = rows.get(keyOf(organizationId, callId))
      if (row === undefined || row.state !== 'storing') {
        return false
      }
      row.state = 'stored'
      row.sizeBytes = stored.sizeBytes
      return true
    },
    async get(organizationId, callId) {
      const row = rows.get(keyOf(organizationId, callId))
      return row === undefined ? undefined : view(row)
    },
    async states(organizationId, callIds) {
      const states = new Map<string, StoredRecording['state']>()
      for (const callId of callIds) {
        const row = rows.get(keyOf(organizationId, callId))
        if (row !== undefined) {
          states.set(callId, row.state)
        }
      }
      return states
    },
    async markDeleted(organizationId, callId, deletion) {
      const row = rows.get(keyOf(organizationId, callId))
      if (row !== undefined && row.state !== 'deleted') {
        row.state = 'deleted'
        row.purgeDueAt = deletion.purgeDueAt
      }
      return row === undefined ? undefined : view(row)
    },
    async organizationsWithDue(before, after, limit) {
      const ids = new Set<string>()
      for (const row of rows.values()) {
        if (
          row.state === 'deleted' &&
          row.purgeDueAt !== null &&
          row.purgeDueAt <= before &&
          (after === null || row.organizationId > after)
        ) {
          ids.add(row.organizationId)
        }
      }
      return [...ids].sort().slice(0, limit)
    },
    async due(organizationId, before, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.organizationId === organizationId &&
            row.state === 'deleted' &&
            row.purgeDueAt !== null &&
            row.purgeDueAt <= before
        )
        .sort((a, b) => (a.callId < b.callId ? -1 : 1))
        .slice(0, limit)
        .map(view)
    },
    async finishPurge(organizationId, callId) {
      const row = rows.get(keyOf(organizationId, callId))
      if (row !== undefined) {
        row.purgeDueAt = null
      }
    },
  }
}
