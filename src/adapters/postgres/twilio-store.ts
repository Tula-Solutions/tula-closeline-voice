import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq, sql } from 'drizzle-orm'
import { type Database, type Transaction, withOrganization } from 'tula-closeline-db'
import {
  voiceTwilioCalls,
  voiceTwilioPlacements,
  voiceTwilioRecordings,
} from 'tula-closeline-db/schema'
import type { TwilioCallRecord, TwilioStore } from 'tula-closeline-kit'

const UNIQUE_VIOLATION = '23505'
const DAY_MS = 86_400_000

/** How long a call record lives before the purge may remove it; a call is over long before. */
export const TWILIO_CALL_TTL_MS = 7 * DAY_MS
/** How long a placement answers a repeated idempotency key before the purge may remove it. */
export const TWILIO_PLACEMENT_TTL_MS = 7 * DAY_MS

type CallRow = typeof voiceTwilioCalls.$inferSelect
type Executor = Database | Transaction
type Owner = { organizationId: string; providerCallId: string }

/** The `withCall` transaction that is open for a provider call, so get/put inside `fn` join it. */
const active = new AsyncLocalStorage<{ providerCallId: string; tx: Transaction }>()

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

/** The Organization behind a provider call or a Recording, from the owner function; null if none. */
async function ownerOf(
  executor: Executor,
  kind: 'call' | 'recording',
  id: string
): Promise<Owner | null> {
  const result = await executor.execute<{ organization_id: string; provider_call_id: string }>(
    sql`select * from voice.twilio_owner(${kind}, ${id})`
  )
  const row = result.rows[0]
  return row === undefined
    ? null
    : { organizationId: row.organization_id, providerCallId: row.provider_call_id }
}

function toRecord(row: CallRow): TwilioCallRecord {
  const disclosure =
    row.disclosureWordingVersion === null ||
    row.disclosureAiAssisted === null ||
    row.disclosurePlayedAt === null
      ? null
      : {
          wordingVersion: row.disclosureWordingVersion,
          aiAssisted: row.disclosureAiAssisted,
          playedAt: row.disclosurePlayedAt.toISOString(),
        }
  return {
    organizationId: row.organizationId,
    callId: row.callId,
    direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
    disclosure,
    bridgedTo: row.bridgedTo,
    ...(row.disclosureStarted ? { disclosureStarted: true } : {}),
    ringIdentities: row.ringIdentities,
    recordingId: row.recordingId,
    streamId: row.streamId,
  }
}

function toValues(providerCallId: string, record: TwilioCallRecord) {
  return {
    organizationId: record.organizationId,
    providerCallId,
    callId: record.callId,
    direction: record.direction,
    disclosureWordingVersion: record.disclosure?.wordingVersion ?? null,
    disclosureAiAssisted: record.disclosure?.aiAssisted ?? null,
    disclosurePlayedAt: record.disclosure === null ? null : new Date(record.disclosure.playedAt),
    disclosureStarted: record.disclosureStarted ?? false,
    bridgedTo: record.bridgedTo,
    ringIdentities: [...record.ringIdentities],
    recordingId: record.recordingId,
    streamId: record.streamId,
  }
}

const callKey = (organizationId: string, providerCallId: string) =>
  and(
    eq(voiceTwilioCalls.organizationId, organizationId),
    eq(voiceTwilioCalls.providerCallId, providerCallId)
  )

/**
 * The Postgres {@link TwilioStore}. A call is looked up by provider id before its Organization is
 * known, so each read first asks `voice.twilio_owner` (the one door into the directory) and then
 * reads through `withOrganization` under that Organization, so row-level security still applies.
 * `withCall` holds `FOR UPDATE` on the row (or an advisory lock while the row is absent) for the
 * whole of `fn`, and the get and put calls `fn` makes join that transaction. Rows carry
 * `expires_at`; the purge that removes them is a separate job.
 */
export function createPostgresTwilioStore(db: Database): TwilioStore {
  /** Runs `fn` in the open `withCall` transaction for this call, or in a fresh scoped one. */
  async function scoped<T>(
    providerCallId: string,
    organizationId: string,
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    const open = active.getStore()
    if (open !== undefined && open.providerCallId === providerCallId) {
      // The absent-row path of `withCall` holds no Organization yet; set it for this statement.
      await open.tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`)
      return fn(open.tx)
    }
    return withOrganization(db, organizationId, fn)
  }

  /** The executor to ask the directory with: the open `withCall` transaction sees its own inserts. */
  const directoryExecutor = (providerCallId: string): Executor => {
    const open = active.getStore()
    return open !== undefined && open.providerCallId === providerCallId ? open.tx : db
  }

  async function readCall(owner: Owner): Promise<TwilioCallRecord | null> {
    const [row] = await scoped(owner.providerCallId, owner.organizationId, (tx) =>
      tx
        .select()
        .from(voiceTwilioCalls)
        .where(callKey(owner.organizationId, owner.providerCallId))
        .limit(1)
    )
    return row === undefined ? null : toRecord(row)
  }

  return {
    async getCall(providerCallId) {
      const owner = await ownerOf(directoryExecutor(providerCallId), 'call', providerCallId)
      return owner === null ? null : readCall(owner)
    },

    async putCall(providerCallId, record) {
      const values = toValues(providerCallId, record)
      const { organizationId: _o, providerCallId: _p, ...changes } = values
      await scoped(providerCallId, record.organizationId, (tx) =>
        tx
          .insert(voiceTwilioCalls)
          .values({ ...values, expiresAt: new Date(Date.now() + TWILIO_CALL_TTL_MS) })
          .onConflictDoUpdate({
            target: [voiceTwilioCalls.organizationId, voiceTwilioCalls.providerCallId],
            set: { ...changes, updatedAt: new Date() },
          })
      )
    },

    async withCall(providerCallId, fn) {
      return db.transaction(async (tx) => {
        let owner = await ownerOf(tx, 'call', providerCallId)
        if (owner === null) {
          // No row to lock yet: serialise the creators on the id, then look again, since the
          // one that held the lock may have inserted the row before it released.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${providerCallId}))`)
          owner = await ownerOf(tx, 'call', providerCallId)
        }
        let current: TwilioCallRecord | null = null
        if (owner !== null) {
          await tx.execute(
            sql`select set_config('app.organization_id', ${owner.organizationId}, true)`
          )
          const [row] = await tx
            .select()
            .from(voiceTwilioCalls)
            .where(callKey(owner.organizationId, providerCallId))
            .for('update')
            .limit(1)
          current = row === undefined ? null : toRecord(row)
        }
        return active.run({ providerCallId, tx }, () => fn(current))
      })
    },

    async claimCall(providerCallId, record) {
      try {
        const inserted = await withOrganization(db, record.organizationId, (tx) =>
          tx
            .insert(voiceTwilioCalls)
            .values({
              ...toValues(providerCallId, record),
              expiresAt: new Date(Date.now() + TWILIO_CALL_TTL_MS),
            })
            .onConflictDoNothing()
            .returning({ id: voiceTwilioCalls.providerCallId })
        )
        if (inserted.length > 0) {
          return record
        }
      } catch (error) {
        // Another Organization holds this provider call id: the directory refuses the insert.
        if (!isUniqueViolation(error)) {
          throw error
        }
      }
      const owner = await ownerOf(db, 'call', providerCallId)
      const standing = owner === null ? null : await readCall(owner)
      if (standing === null) {
        throw new Error('claimCall: the standing record vanished before it could be read')
      }
      return standing
    },

    async getRecording(recordingId) {
      const owner = await ownerOf(db, 'recording', recordingId)
      if (owner === null) {
        return null
      }
      const [row] = await withOrganization(db, owner.organizationId, (tx) =>
        tx
          .select({ providerCallId: voiceTwilioRecordings.providerCallId })
          .from(voiceTwilioRecordings)
          .where(
            and(
              eq(voiceTwilioRecordings.organizationId, owner.organizationId),
              eq(voiceTwilioRecordings.recordingId, recordingId)
            )
          )
          .limit(1)
      )
      return row === undefined ? null : { providerCallId: row.providerCallId }
    },

    async putRecording(recordingId, providerCallId) {
      const owner = await ownerOf(directoryExecutor(providerCallId), 'call', providerCallId)
      if (owner === null) {
        throw new Error('putRecording: the provider call is not stored')
      }
      await scoped(providerCallId, owner.organizationId, (tx) =>
        tx
          .insert(voiceTwilioRecordings)
          .values({ organizationId: owner.organizationId, recordingId, providerCallId })
          .onConflictDoNothing()
      )
    },

    async getPlacement(organizationId, key) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .select({
            providerCallId: voiceTwilioPlacements.providerCallId,
            fingerprint: voiceTwilioPlacements.fingerprint,
          })
          .from(voiceTwilioPlacements)
          .where(
            and(
              eq(voiceTwilioPlacements.organizationId, organizationId),
              eq(voiceTwilioPlacements.idempotencyKey, key)
            )
          )
          .limit(1)
      )
      return row === undefined
        ? null
        : { providerCallId: row.providerCallId, fingerprint: row.fingerprint }
    },

    async putPlacement(organizationId, key, placement) {
      await withOrganization(db, organizationId, (tx) =>
        tx
          .insert(voiceTwilioPlacements)
          .values({
            organizationId,
            idempotencyKey: key,
            providerCallId: placement.providerCallId,
            fingerprint: placement.fingerprint,
            expiresAt: new Date(Date.now() + TWILIO_PLACEMENT_TTL_MS),
          })
          .onConflictDoNothing()
      )
    },
  }
}
