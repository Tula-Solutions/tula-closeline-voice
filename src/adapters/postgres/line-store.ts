import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { lineSchema } from 'tula-closeline-contract'
import { type Database, type Transaction, withOrganization } from 'tula-closeline-db'
import { voiceLines } from 'tula-closeline-db/schema'
import { transactionOf } from '~/adapters/postgres/idempotency-store'
import { type LineStore, NumberTakenError, type StoredLine } from '~/ports/line-store'

type Row = typeof voiceLines.$inferSelect

const UNIQUE_VIOLATION = '23505'

function assignmentOf(row: Row): unknown {
  switch (row.assignmentKind) {
    case 'team':
      return { kind: 'team', teamId: row.assignmentTeamId }
    case 'rep':
      return { kind: 'rep', membershipId: row.assignmentMembershipId }
    default:
      return { kind: 'unassigned' }
  }
}

/** Reads a row through the contract's schema, so a row that breaks the contract fails loudly. */
function toStored(row: Row): StoredLine {
  const line = lineSchema.parse({
    id: row.id,
    number: row.number,
    country: row.country,
    label: row.label,
    state: row.state,
    assignment: assignmentOf(row),
    createdAt: row.createdAt.toISOString(),
    releasedAt: row.releasedAt === null ? null : row.releasedAt.toISOString(),
  })
  return { ...line, providerSid: row.providerSid }
}

/** Whether Postgres rejected the statement for a duplicate key, however the driver wraps it. */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === UNIQUE_VIOLATION) {
      return true
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined
  }
  return false
}

/**
 * The Postgres {@link LineStore}: every statement runs inside `withOrganization`, so row-level
 * security confines it to the caller's Organization on top of the explicit filter.
 */
export function createPostgresLineStore(db: Database): LineStore {
  const one = (organizationId: string, id: string) =>
    and(eq(voiceLines.organizationId, organizationId), eq(voiceLines.id, id))

  return {
    async insert(organizationId, line, within) {
      const write = (tx: Transaction) =>
        tx
          .insert(voiceLines)
          .values({
            id: line.id,
            organizationId,
            number: line.number,
            country: line.country,
            label: line.label,
            state: line.state,
            providerSid: line.providerSid,
            createdAt: line.createdAt,
          })
          .returning()
      try {
        // Inside an idempotency transaction the Line joins it; a failed insert aborts that
        // transaction, which the caller then rolls back along with the key.
        const joined = within === undefined ? undefined : transactionOf(within)
        const [row] = await (joined === undefined
          ? withOrganization(db, organizationId, write)
          : write(joined))
        if (row === undefined) {
          throw new Error('insert returned no row')
        }
        return toStored(row)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new NumberTakenError()
        }
        throw error
      }
    },

    async list(organizationId, query) {
      const rows = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceLines)
          .where(
            and(
              eq(voiceLines.organizationId, organizationId),
              query.state === undefined ? undefined : eq(voiceLines.state, query.state),
              query.cursor === undefined
                ? undefined
                : sql`(${voiceLines.createdAt}, ${voiceLines.id}) < (${query.cursor.createdAt}::timestamptz, ${query.cursor.id})`
            )
          )
          .orderBy(desc(voiceLines.createdAt), desc(voiceLines.id))
          .limit(query.limit)
      )
      return rows.map(toStored)
    },

    async get(organizationId, id) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx.select().from(voiceLines).where(one(organizationId, id)).limit(1)
      )
      return row === undefined ? undefined : toStored(row)
    },

    async assign(organizationId, id, assignment) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .update(voiceLines)
          .set({
            assignmentKind: assignment.kind,
            assignmentTeamId: assignment.kind === 'team' ? assignment.teamId : null,
            assignmentMembershipId: assignment.kind === 'rep' ? assignment.membershipId : null,
          })
          .where(and(one(organizationId, id), ne(voiceLines.state, 'released')))
          .returning()
      )
      return row === undefined ? undefined : toStored(row)
    },

    async release(organizationId, id, at) {
      return withOrganization(db, organizationId, async (tx) => {
        const [released] = await tx
          .update(voiceLines)
          .set({
            state: 'released',
            assignmentKind: 'unassigned',
            assignmentTeamId: null,
            assignmentMembershipId: null,
            releasedAt: at,
          })
          .where(and(one(organizationId, id), ne(voiceLines.state, 'released')))
          .returning()
        if (released !== undefined) {
          return toStored(released)
        }
        const [existing] = await tx
          .select()
          .from(voiceLines)
          .where(one(organizationId, id))
          .limit(1)
        return existing === undefined ? undefined : toStored(existing)
      })
    },
    async clearProviderSid(organizationId, id) {
      await withOrganization(db, organizationId, async (tx) => {
        await tx
          .update(voiceLines)
          .set({ providerSid: null })
          .where(and(one(organizationId, id), eq(voiceLines.state, 'released')))
      })
    },
  }
}
