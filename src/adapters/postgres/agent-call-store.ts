import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { agentCallSchema } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceAgentCalls, voiceLines } from 'tula-closeline-db/schema'
import {
  AgentCallOpenError,
  type AgentCallStore,
  type StoredAgentCall,
} from '~/ports/agent-call-store'

type Row = typeof voiceAgentCalls.$inferSelect

const UNIQUE_VIOLATION = '23505'
const OPEN_STATES = ['queued', 'dialing', 'live'] as const

/** Reads a row through the contract's schema, so a row that breaks the contract fails loudly. */
function toStored(row: Row): StoredAgentCall {
  const iso = (at: Date | null) => (at === null ? null : at.toISOString())
  return agentCallSchema.parse({
    id: row.id,
    source: row.source,
    prospectId: row.prospectId,
    lineId: row.lineId,
    enrollmentId: row.enrollmentId,
    stepKey: row.stepKey,
    requestedByMembershipId: row.requestedByMembershipId,
    attempt: row.attempt,
    state: row.state,
    result: row.result,
    endReason: row.endReason,
    gateCode: row.gateCode,
    retryAt: iso(row.retryAt),
    callId: row.callId,
    durationSeconds: row.durationSeconds,
    createdAt: row.createdAt.toISOString(),
    endedAt: iso(row.endedAt),
  })
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
 * The Postgres {@link AgentCallStore}: every statement runs inside `withOrganization`, so row-level
 * security confines it to the caller's Organization on top of the explicit filter.
 */
export function createPostgresAgentCallStore(db: Database): AgentCallStore {
  const inOrg = (organizationId: string) => eq(voiceAgentCalls.organizationId, organizationId)
  const first = async (organizationId: string, where: ReturnType<typeof and>) => {
    const [row] = await withOrganization(db, organizationId, (tx) =>
      tx.select().from(voiceAgentCalls).where(where).limit(1)
    )
    return row === undefined ? undefined : toStored(row)
  }
  const byKey: AgentCallStore['byKey'] = (organizationId, key) =>
    first(organizationId, and(inOrg(organizationId), eq(voiceAgentCalls.idempotencyKey, key)))
  const openFor: AgentCallStore['openFor'] = (organizationId, prospectId) =>
    first(
      organizationId,
      and(
        inOrg(organizationId),
        eq(voiceAgentCalls.prospectId, prospectId),
        inArray(voiceAgentCalls.state, [...OPEN_STATES])
      )
    )

  return {
    byKey,
    openFor,
    get: (organizationId, id) =>
      first(organizationId, and(inOrg(organizationId), eq(voiceAgentCalls.id, id))),

    async insert(organizationId, call) {
      try {
        const [row] = await withOrganization(db, organizationId, (tx) =>
          tx
            .insert(voiceAgentCalls)
            .values({
              id: call.id,
              organizationId,
              idempotencyKey: call.idempotencyKey,
              source: call.source,
              prospectId: call.prospectId,
              lineId: call.lineId,
              enrollmentId: call.enrollmentId,
              stepKey: call.stepKey,
              requestedByMembershipId: call.requestedByMembershipId,
              attempt: call.attempt,
              state: call.state,
              result: call.result,
              gateCode: call.gateCode,
              retryAt: call.retryAt,
              createdAt: call.createdAt,
              endedAt: call.state === 'ended' ? call.createdAt : null,
            })
            .onConflictDoNothing({
              target: [voiceAgentCalls.organizationId, voiceAgentCalls.idempotencyKey],
            })
            .returning()
        )
        if (row !== undefined) {
          return { call: toStored(row), created: true }
        }
        const existing = await byKey(organizationId, call.idempotencyKey)
        if (existing === undefined) {
          throw new Error('insert conflicted but the Agent Call is gone')
        }
        return { call: existing, created: false }
      } catch (error) {
        if (isUniqueViolation(error)) {
          // The key conflict is handled above, so this is the one-open-Call-per-Prospect index.
          const open = await openFor(organizationId, call.prospectId)
          if (open !== undefined) {
            throw new AgentCallOpenError(open.id)
          }
        }
        throw error
      }
    },

    async numberDials(organizationId, numberHash, since) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .select({
            count: sql<number>`count(*)::int`,
            oldest: sql<Date | null>`min(${voiceAgentCalls.dialedAt})`,
          })
          .from(voiceAgentCalls)
          .where(
            and(
              inOrg(organizationId),
              eq(voiceAgentCalls.numberHash, Buffer.from(numberHash)),
              gte(voiceAgentCalls.dialedAt, since)
            )
          )
      )
      return { count: row?.count ?? 0, oldestAt: row?.oldest ? new Date(row.oldest) : null }
    },

    async stepAttempts(organizationId, enrollmentId, stepKey) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .select({
            dialed: sql<number>`count(*)::int`,
            answered: sql<boolean>`coalesce(bool_or(${voiceAgentCalls.result} = 'answered'), false)`,
          })
          .from(voiceAgentCalls)
          .where(
            and(
              inOrg(organizationId),
              eq(voiceAgentCalls.enrollmentId, enrollmentId),
              eq(voiceAgentCalls.stepKey, stepKey),
              isNotNull(voiceAgentCalls.dialedAt)
            )
          )
      )
      return { dialed: row?.dialed ?? 0, answered: row?.answered ?? false }
    },

    async lineUsage(organizationId, lineId, since) {
      return withOrganization(db, organizationId, async (tx) => {
        const [line] = await tx
          .select({
            maxConcurrentAgentCalls: voiceLines.maxConcurrentAgentCalls,
            dailyAgentDialCap: voiceLines.dailyAgentDialCap,
          })
          .from(voiceLines)
          .where(and(eq(voiceLines.organizationId, organizationId), eq(voiceLines.id, lineId)))
          .limit(1)
        if (line === undefined) {
          return undefined
        }
        const [use] = await tx
          .select({
            open: sql<number>`count(*) filter (where ${voiceAgentCalls.state} in ('dialing', 'live'))::int`,
            dials: sql<number>`count(*) filter (where ${voiceAgentCalls.dialedAt} >= ${since})::int`,
            oldest: sql<Date | null>`min(${voiceAgentCalls.dialedAt}) filter (where ${voiceAgentCalls.dialedAt} >= ${since})`,
          })
          .from(voiceAgentCalls)
          .where(and(inOrg(organizationId), eq(voiceAgentCalls.lineId, lineId)))
        return {
          ...line,
          open: use?.open ?? 0,
          dials: use?.dials ?? 0,
          oldestDialAt: use?.oldest ? new Date(use.oldest) : null,
        }
      })
    },

    async settle(organizationId, id, settlement) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .update(voiceAgentCalls)
          .set(
            settlement.kind === 'blocked'
              ? {
                  state: 'ended',
                  result: 'blocked',
                  gateCode: settlement.gateCode,
                  retryAt: null,
                  endedAt: settlement.at,
                }
              : { gateCode: settlement.gateCode, retryAt: settlement.retryAt }
          )
          .where(
            and(
              inOrg(organizationId),
              eq(voiceAgentCalls.id, id),
              eq(voiceAgentCalls.state, 'queued')
            )
          )
          .returning()
      )
      return row === undefined ? undefined : toStored(row)
    },
  }
}
