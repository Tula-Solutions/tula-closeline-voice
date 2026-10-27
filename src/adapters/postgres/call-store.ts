import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { formatId, voiceCallSchema } from 'tula-closeline-contract'
import { type Database, type Transaction, withOrganization } from 'tula-closeline-db'
import { voiceCallEvents, voiceCalls } from 'tula-closeline-db/schema'
import { transactionOf } from '~/adapters/postgres/idempotency-store'
import { canTransition } from '~/modules/call/state'
import {
  CallKeyTakenError,
  type CallLogEntry,
  type CallStore,
  InvalidTransitionError,
  type StoredCall,
} from '~/ports/call-store'

type Row = typeof voiceCalls.$inferSelect

const UNIQUE_VIOLATION = '23505'

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

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString())

/** Reads a row through the contract's schema, so a row that breaks the contract fails loudly. */
function toStored(row: Row): StoredCall {
  const call = voiceCallSchema.parse({
    id: row.id,
    direction: row.direction,
    state: row.state,
    lineId: row.lineId,
    repMembershipId: row.repMembershipId,
    prospectId: row.prospectId,
    prospectNumber: row.prospectNumber,
    disclosure: {
      wordingVersion: row.disclosureWordingVersion,
      playedAt: iso(row.disclosurePlayedAt),
      aiAssisted: row.aiAssisted,
    },
    createdAt: row.createdAt.toISOString(),
    answeredAt: iso(row.answeredAt),
    endedAt: iso(row.endedAt),
    durationSeconds: row.durationSeconds,
    endedBy: row.endedBy,
    failureReason: row.failureReason,
    dealId: row.dealId,
    note: row.note,
    // The Recording has no row of its own until the Recording ticket, so it reads as none.
    recordingState: 'none',
    transcriptState: row.transcriptState,
  })
  return { ...call, providerCallSid: row.providerCallSid }
}

/**
 * The Postgres {@link CallStore}: every statement runs inside `withOrganization`, so row-level
 * security confines it to the caller's Organization on top of the explicit filter. A change of
 * state and its log entry are written in one transaction, after locking the Call's row.
 */
export function createPostgresCallStore(db: Database): CallStore {
  const one = (organizationId: string, id: string) =>
    and(eq(voiceCalls.organizationId, organizationId), eq(voiceCalls.id, id))

  const log = (
    tx: Transaction,
    organizationId: string,
    callId: string,
    entry: Omit<typeof voiceCallEvents.$inferInsert, 'id' | 'organizationId' | 'callId'>
  ) =>
    tx.insert(voiceCallEvents).values({
      id: formatId('vev', crypto.randomUUID()),
      organizationId,
      callId,
      ...entry,
    })

  /** Locks the Call's row for the rest of the transaction. */
  const lock = async (tx: Transaction, organizationId: string, id: string) => {
    const [row] = await tx.select().from(voiceCalls).where(one(organizationId, id)).for('update')
    return row
  }

  return {
    async insert(organizationId, call, within) {
      const write = async (tx: Transaction) => {
        const [row] = await tx
          .insert(voiceCalls)
          .values({
            id: call.id,
            organizationId,
            direction: 'outbound',
            state: 'ringing',
            lineId: call.lineId,
            repMembershipId: call.repMembershipId,
            prospectId: call.prospectId,
            prospectNumber: call.prospectNumber,
            idempotencyKey: call.idempotency?.key ?? null,
            requestFingerprint: call.idempotency?.fingerprint ?? null,
            createdAt: call.createdAt,
          })
          .returning()
        if (row === undefined) {
          throw new Error('insert returned no row')
        }
        await log(tx, organizationId, call.id, {
          kind: 'state_changed',
          fromState: null,
          toState: 'ringing',
          occurredAt: call.createdAt,
        })
        return toStored(row)
      }
      try {
        const joined = within === undefined ? undefined : transactionOf(within)
        return await (joined === undefined
          ? withOrganization(db, organizationId, write)
          : write(joined))
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new CallKeyTakenError()
        }
        throw error
      }
    },

    async insertInbound(organizationId, call) {
      return withOrganization(db, organizationId, async (tx) => {
        // The unique index on (organization, provider call id) makes a redelivered webhook a no-op.
        const [row] = await tx
          .insert(voiceCalls)
          .values({
            id: call.id,
            organizationId,
            direction: 'inbound',
            state: 'ringing',
            lineId: call.lineId,
            repMembershipId: call.repMembershipId,
            prospectNumber: call.callerNumber,
            providerCallSid: call.providerCallSid,
            createdAt: call.createdAt,
          })
          .onConflictDoNothing()
          .returning()
        if (row === undefined) {
          const [existing] = await tx
            .select()
            .from(voiceCalls)
            .where(
              and(
                eq(voiceCalls.organizationId, organizationId),
                eq(voiceCalls.providerCallSid, call.providerCallSid)
              )
            )
            .limit(1)
          if (existing === undefined) {
            throw new Error('insert conflicted but found no Call')
          }
          return { call: toStored(existing), created: false }
        }
        await log(tx, organizationId, call.id, {
          kind: 'state_changed',
          fromState: null,
          toState: 'ringing',
          occurredAt: call.createdAt,
        })
        return { call: toStored(row), created: true }
      })
    },

    async claimInbound(organizationId, id, repMembershipId, at) {
      return withOrganization(db, organizationId, async (tx) => {
        // One conditional update decides the race: only one statement finds the row `ringing`.
        const [row] = await tx
          .update(voiceCalls)
          .set({ state: 'connecting', repMembershipId, updatedAt: sql`now()` })
          .where(
            and(
              one(organizationId, id),
              eq(voiceCalls.direction, 'inbound'),
              eq(voiceCalls.state, 'ringing'),
              sql`(${voiceCalls.repMembershipId} is null or ${voiceCalls.repMembershipId} = ${repMembershipId})`
            )
          )
          .returning()
        if (row === undefined) {
          return undefined
        }
        await log(tx, organizationId, id, {
          kind: 'state_changed',
          fromState: 'ringing',
          toState: 'connecting',
          occurredAt: at,
        })
        return toStored(row)
      })
    },

    async get(organizationId, id) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx.select().from(voiceCalls).where(one(organizationId, id)).limit(1)
      )
      return row === undefined ? undefined : toStored(row)
    },

    async list(organizationId, query) {
      const rows = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceCalls)
          .where(
            and(
              eq(voiceCalls.organizationId, organizationId),
              query.repMembershipIds === undefined
                ? undefined
                : query.repMembershipIds.length === 0
                  ? sql`false`
                  : inArray(voiceCalls.repMembershipId, [...query.repMembershipIds]),
              query.state === undefined ? undefined : eq(voiceCalls.state, query.state),
              query.direction === undefined ? undefined : eq(voiceCalls.direction, query.direction),
              query.repMembershipId === undefined
                ? undefined
                : eq(voiceCalls.repMembershipId, query.repMembershipId),
              query.lineId === undefined ? undefined : eq(voiceCalls.lineId, query.lineId),
              query.prospectId === undefined
                ? undefined
                : eq(voiceCalls.prospectId, query.prospectId),
              query.from === undefined ? undefined : gte(voiceCalls.createdAt, query.from),
              query.to === undefined ? undefined : lt(voiceCalls.createdAt, query.to),
              query.cursor === undefined
                ? undefined
                : sql`(${voiceCalls.createdAt}, ${voiceCalls.id}) < (${query.cursor.createdAt}::timestamptz, ${query.cursor.id})`
            )
          )
          .orderBy(desc(voiceCalls.createdAt), desc(voiceCalls.id))
          .limit(query.limit)
      )
      return rows.map(toStored)
    },

    async setProviderCallSid(organizationId, id, providerCallSid) {
      await withOrganization(db, organizationId, (tx) =>
        tx
          .update(voiceCalls)
          .set({ providerCallSid, updatedAt: sql`now()` })
          .where(one(organizationId, id))
      )
    },

    async transition(organizationId, id, move) {
      return withOrganization(db, organizationId, async (tx) => {
        const current = await lock(tx, organizationId, id)
        if (current === undefined) {
          return undefined
        }
        const played = current.disclosurePlayedAt !== null
        if (
          !canTransition(current.state, move.to, current.disclosureWordingVersion) ||
          (move.to === 'failed') !== (move.failureReason !== undefined) ||
          (move.failureReason === 'disclosure_failed' && played)
        ) {
          throw new InvalidTransitionError(current.state, move.to)
        }
        const final = move.to === 'ended' || move.to === 'failed' || move.to === 'missed'
        const answeredAt = move.to === 'live' ? move.at : current.answeredAt
        const [row] = await tx
          .update(voiceCalls)
          .set({
            state: move.to,
            answeredAt,
            endedAt: final ? move.at : null,
            endedBy: final ? (move.endedBy ?? null) : null,
            failureReason: move.failureReason ?? null,
            durationSeconds:
              move.to === 'ended' && answeredAt !== null
                ? Math.max(0, Math.floor((move.at.getTime() - answeredAt.getTime()) / 1000))
                : null,
            updatedAt: sql`now()`,
          })
          .where(one(organizationId, id))
          .returning()
        if (row === undefined) {
          throw new Error('update returned no row')
        }
        await log(tx, organizationId, id, {
          kind: 'state_changed',
          fromState: current.state,
          toState: move.to,
          occurredAt: move.at,
        })
        return toStored(row)
      })
    },

    async recordDisclosure(organizationId, id, disclosure) {
      return withOrganization(db, organizationId, async (tx) => {
        const current = await lock(tx, organizationId, id)
        if (current === undefined) {
          return undefined
        }
        if (current.state !== 'disclosing' || current.disclosurePlayedAt !== null) {
          throw new InvalidTransitionError(current.state, 'disclosing')
        }
        const [row] = await tx
          .update(voiceCalls)
          .set({
            disclosureWordingVersion: disclosure.wordingVersion,
            disclosurePlayedAt: disclosure.playedAt,
            aiAssisted: disclosure.aiAssisted,
            updatedAt: sql`now()`,
          })
          .where(one(organizationId, id))
          .returning()
        if (row === undefined) {
          throw new Error('update returned no row')
        }
        await log(tx, organizationId, id, {
          kind: 'disclosure_played',
          occurredAt: disclosure.playedAt,
        })
        return toStored(row)
      })
    },

    async recordRecordingStarted(organizationId, id, at) {
      await withOrganization(db, organizationId, async (tx) => {
        const current = await lock(tx, organizationId, id)
        if (current === undefined) {
          return
        }
        if (current.disclosurePlayedAt === null) {
          throw new InvalidTransitionError(current.state, current.state)
        }
        await log(tx, organizationId, id, { kind: 'recording_started', occurredAt: at })
      })
    },

    async wrapUp(organizationId, id, wrapUp) {
      return withOrganization(db, organizationId, async (tx) => {
        const current = await lock(tx, organizationId, id)
        if (current === undefined) {
          return undefined
        }
        if (current.state !== 'ended') {
          throw new InvalidTransitionError(current.state, 'ended')
        }
        const [row] = await tx
          .update(voiceCalls)
          .set({
            ...(wrapUp.dealId === undefined ? {} : { dealId: wrapUp.dealId }),
            ...(wrapUp.note === undefined ? {} : { note: wrapUp.note }),
            updatedAt: sql`now()`,
          })
          .where(one(organizationId, id))
          .returning()
        return row === undefined ? undefined : toStored(row)
      })
    },

    async events(organizationId, id) {
      const rows = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceCallEvents)
          .where(
            and(eq(voiceCallEvents.organizationId, organizationId), eq(voiceCallEvents.callId, id))
          )
          .orderBy(asc(voiceCallEvents.seq))
      )
      const entries: CallLogEntry[] = []
      for (const row of rows) {
        if (row.kind === 'state_changed' && row.toState !== null) {
          entries.push({
            kind: 'state_changed',
            fromState: row.fromState,
            toState: row.toState,
            at: row.occurredAt,
          })
        } else if (row.kind === 'disclosure_played' || row.kind === 'recording_started') {
          entries.push({ kind: row.kind, at: row.occurredAt })
        }
      }
      return entries
    },
  }
}
