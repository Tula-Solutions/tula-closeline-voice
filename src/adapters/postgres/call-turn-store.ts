import { and, asc, eq, gt, or, sql } from 'drizzle-orm'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceCallTurns } from 'tula-closeline-db/schema'
import {
  type CallTurnStore,
  MAX_TURN_PAGE,
  type StoredCallTurn,
  type TurnTrack,
} from '~/ports/call-turn-store'

type Row = typeof voiceCallTurns.$inferSelect

const toStored = (row: Row): StoredCallTurn => ({
  track: row.track as TurnTrack,
  sequence: row.sequence,
  text: row.text,
  startMs: row.startMs,
  endMs: row.endMs,
})

/** A {@link CallTurnStore} over `voice.call_turns`. */
export function createPostgresCallTurnStore(db: Database): CallTurnStore {
  return {
    async append(organizationId, callId, turn) {
      return withOrganization(db, organizationId, async (tx) => {
        const [row] = await tx
          .insert(voiceCallTurns)
          .values({
            organizationId,
            callId,
            track: turn.track,
            // The next sequence on the track; two writers racing for it collide on the primary key.
            sequence: sql`(select coalesce(max(t.sequence), 0) + 1 from voice.call_turns t where t.organization_id = ${organizationId} and t.call_id = ${callId} and t.track = ${turn.track})`,
            text: turn.text,
            startMs: turn.startMs,
            endMs: turn.endMs,
          })
          .returning()
        if (row === undefined) {
          throw new Error('call turn insert returned no row')
        }
        return toStored(row)
      })
    },
    async list(organizationId, callId, cursor, limit) {
      const size = Math.min(Math.max(limit, 1), MAX_TURN_PAGE)
      return withOrganization(db, organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(voiceCallTurns)
          .where(
            and(
              eq(voiceCallTurns.organizationId, organizationId),
              eq(voiceCallTurns.callId, callId),
              or(
                and(eq(voiceCallTurns.track, 'rep'), gt(voiceCallTurns.sequence, cursor.rep)),
                and(
                  eq(voiceCallTurns.track, 'prospect'),
                  gt(voiceCallTurns.sequence, cursor.prospect)
                )
              )
            )
          )
          .orderBy(
            asc(voiceCallTurns.startMs),
            asc(voiceCallTurns.track),
            asc(voiceCallTurns.sequence)
          )
          .limit(size)
        return rows.map(toStored)
      })
    },
  }
}
