import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { formatId, type Handoff, handoffSchema } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceHandoffs } from 'tula-closeline-db/schema'
import { type HandoffStore, MAX_HANDOFF_ATTEMPTS } from '~/ports/handoff-store'

type Row = typeof voiceHandoffs.$inferSelect

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString())

/** Reads a row through the contract's schema, so a row that breaks the contract fails loudly. */
function toHandoff(row: Row): Handoff {
  return handoffSchema.parse({
    id: row.id,
    state: row.state,
    channel: row.channel,
    callId: row.callId,
    chatId: row.chatId,
    repMembershipId: row.repMembershipId,
    attempt: row.attempt,
    reason: row.reason,
    requestedAt: row.requestedAt.toISOString(),
    answeredAt: iso(row.answeredAt),
    completedAt: iso(row.completedAt),
  })
}

/** A {@link HandoffStore} over `voice.handoffs`; each change is one conditional update. */
export function createPostgresHandoffStore(db: Database): HandoffStore {
  const one = (organizationId: string, id: string) =>
    and(eq(voiceHandoffs.organizationId, organizationId), eq(voiceHandoffs.id, id))
  const first = (rows: Row[]) => (rows[0] === undefined ? undefined : toHandoff(rows[0]))

  return {
    async offer(organizationId, offer) {
      return withOrganization(db, organizationId, async (tx) =>
        first(
          await tx
            .insert(voiceHandoffs)
            .values({
              id: formatId('hof', crypto.randomUUID()),
              organizationId,
              state: 'pending',
              channel: 'call',
              callId: offer.callId,
              repMembershipId: offer.repMembershipId,
              attempt: offer.attempt,
              reason: offer.reason,
              requestedAt: offer.at,
            })
            // The unique index on live Handoffs of a Call: a second live one changes nothing.
            .onConflictDoNothing()
            .returning()
        )
      )
    },

    async get(organizationId, id) {
      return withOrganization(db, organizationId, async (tx) =>
        first(await tx.select().from(voiceHandoffs).where(one(organizationId, id)))
      )
    },

    async forCall(organizationId, callId) {
      return withOrganization(db, organizationId, async (tx) =>
        (
          await tx
            .select()
            .from(voiceHandoffs)
            .where(
              and(
                eq(voiceHandoffs.organizationId, organizationId),
                eq(voiceHandoffs.callId, callId)
              )
            )
            .orderBy(asc(voiceHandoffs.requestedAt), asc(voiceHandoffs.attempt))
            .limit(MAX_HANDOFF_ATTEMPTS * 2)
        ).map(toHandoff)
      )
    },

    async list(organizationId, query) {
      const reps = query.repMembershipIds
      return withOrganization(db, organizationId, async (tx) =>
        (
          await tx
            .select()
            .from(voiceHandoffs)
            .where(
              and(
                eq(voiceHandoffs.organizationId, organizationId),
                query.state === undefined ? undefined : eq(voiceHandoffs.state, query.state),
                reps === undefined
                  ? undefined
                  : reps.length === 0
                    ? sql`false`
                    : inArray(voiceHandoffs.repMembershipId, [...reps]),
                query.cursor === undefined
                  ? undefined
                  : sql`(${voiceHandoffs.requestedAt}, ${voiceHandoffs.id}) < (${query.cursor.requestedAt}::timestamptz, ${query.cursor.id})`
              )
            )
            .orderBy(desc(voiceHandoffs.requestedAt), desc(voiceHandoffs.id))
            .limit(query.limit)
        ).map(toHandoff)
      )
    },

    async answer(organizationId, id, repMembershipId, answer, at) {
      return withOrganization(db, organizationId, async (tx) =>
        first(
          await tx
            .update(voiceHandoffs)
            .set({
              state: answer,
              answeredAt: at,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                one(organizationId, id),
                eq(voiceHandoffs.state, 'pending'),
                eq(voiceHandoffs.repMembershipId, repMembershipId)
              )
            )
            .returning()
        )
      )
    },

    async expire(organizationId, id) {
      return withOrganization(db, organizationId, async (tx) =>
        first(
          await tx
            .update(voiceHandoffs)
            .set({ state: 'timed_out', updatedAt: sql`now()` })
            .where(and(one(organizationId, id), eq(voiceHandoffs.state, 'pending')))
            .returning()
        )
      )
    },

    async complete(organizationId, id, result, at) {
      return withOrganization(db, organizationId, async (tx) =>
        first(
          await tx
            .update(voiceHandoffs)
            .set({ state: 'completed', result, completedAt: at, updatedAt: sql`now()` })
            .where(and(one(organizationId, id), eq(voiceHandoffs.state, 'accepted')))
            .returning()
        )
      )
    },

    async noRep(organizationId, entry) {
      return withOrganization(db, organizationId, async (tx) => {
        const [row] = await tx
          .insert(voiceHandoffs)
          .values({
            id: formatId('hof', crypto.randomUUID()),
            organizationId,
            state: 'no_rep',
            channel: 'call',
            callId: entry.callId,
            repMembershipId: null,
            attempt: entry.attempt,
            reason: entry.reason,
            result: 'booking_offered',
            requestedAt: entry.at,
            completedAt: entry.at,
          })
          .returning()
        if (row === undefined) {
          throw new Error('handoff insert returned no row')
        }
        return toHandoff(row)
      })
    },
  }
}
