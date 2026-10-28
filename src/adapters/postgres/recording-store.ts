import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { formatId } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceRecordings } from 'tula-closeline-db/schema'
import { type RecordingStore, recordingKeyOf, type StoredRecording } from '~/ports/recording-store'

type Row = typeof voiceRecordings.$inferSelect

const toStored = (row: Row): StoredRecording => ({
  callId: row.callId as StoredRecording['callId'],
  storageKey: row.storageKey,
  sizeBytes: row.sizeBytes,
  state: row.state,
  purgeDueAt: row.purgeDueAt,
})

/** The Postgres {@link RecordingStore}: every statement runs inside `withOrganization`. */
export function createPostgresRecordingStore(db: Database): RecordingStore {
  const mine = (organizationId: string, callId: string) =>
    and(eq(voiceRecordings.organizationId, organizationId), eq(voiceRecordings.callId, callId))

  const read = async (organizationId: string, callId: string) => {
    const [row] = await withOrganization(db, organizationId, (tx) =>
      tx.select().from(voiceRecordings).where(mine(organizationId, callId)).limit(1)
    )
    return row === undefined ? undefined : toStored(row)
  }

  return {
    async begin(organizationId, callId, at) {
      await withOrganization(db, organizationId, (tx) =>
        tx
          .insert(voiceRecordings)
          .values({
            id: formatId('rec', crypto.randomUUID()),
            organizationId,
            callId,
            storageKey: recordingKeyOf(callId),
            channels: 2,
            createdAt: at,
            updatedAt: at,
          })
          .onConflictDoNothing()
      )
      const row = await read(organizationId, callId)
      if (row === undefined) {
        throw new Error('the Recording row vanished after its insert')
      }
      return row
    },

    async markStored(organizationId, callId, stored) {
      const rows = await withOrganization(db, organizationId, (tx) =>
        tx
          .update(voiceRecordings)
          .set({
            state: 'stored',
            sizeBytes: stored.sizeBytes,
            storedAt: stored.at,
            updatedAt: stored.at,
          })
          .where(and(mine(organizationId, callId), eq(voiceRecordings.state, 'storing')))
          .returning({ id: voiceRecordings.id })
      )
      return rows.length === 1
    },

    get: read,

    async states(organizationId, callIds) {
      const states = new Map<string, StoredRecording['state']>()
      if (callIds.length === 0) {
        return states
      }
      const rows = await withOrganization(db, organizationId, (tx) =>
        tx
          .select({ callId: voiceRecordings.callId, state: voiceRecordings.state })
          .from(voiceRecordings)
          .where(
            and(
              eq(voiceRecordings.organizationId, organizationId),
              inArray(voiceRecordings.callId, [...callIds])
            )
          )
      )
      for (const row of rows) {
        states.set(row.callId, row.state)
      }
      return states
    },

    async markDeleted(organizationId, callId, deletion) {
      await withOrganization(db, organizationId, (tx) =>
        tx
          .update(voiceRecordings)
          .set({
            state: 'deleted',
            deletedAt: deletion.at,
            purgeDueAt: deletion.purgeDueAt,
            updatedAt: deletion.at,
          })
          .where(and(mine(organizationId, callId), sql`${voiceRecordings.state} <> 'deleted'`))
      )
      return read(organizationId, callId)
    },

    async organizationsWithDue(before, after, limit) {
      const result = await db.execute<{ organization_id: string }>(
        sql`select organization_id from voice.orgs_with_due_recordings(${before.toISOString()}::timestamptz, ${after}::text, ${limit}::int)`
      )
      return result.rows.map((row: { organization_id: string }) => row.organization_id)
    },

    async due(organizationId, before, limit) {
      const rows = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceRecordings)
          .where(
            and(
              eq(voiceRecordings.organizationId, organizationId),
              eq(voiceRecordings.state, 'deleted'),
              isNotNull(voiceRecordings.purgeDueAt),
              lte(voiceRecordings.purgeDueAt, before)
            )
          )
          .orderBy(asc(voiceRecordings.callId))
          .limit(limit)
      )
      return rows.map(toStored)
    },

    async finishPurge(organizationId, callId) {
      await withOrganization(db, organizationId, (tx) =>
        tx
          .update(voiceRecordings)
          .set({ purgeDueAt: null })
          .where(and(mine(organizationId, callId), eq(voiceRecordings.state, 'deleted')))
      )
    },
  }
}
