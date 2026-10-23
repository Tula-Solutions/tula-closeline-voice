import { sql } from 'drizzle-orm'
import { type Database, type Transaction, withOrganization } from 'tula-closeline-db'
import {
  IdempotencyInProgressError,
  type IdempotencyKeyRef,
  type IdempotencyReservation,
  type IdempotencyScope,
  type IdempotencyStore,
} from '~/ports/idempotency-store'

/** Postgres `lock_not_available`: the statement waited longer than `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03'

/** How many times a reservation re-reads a key whose row vanished or expired under it. */
const RESERVE_ATTEMPTS = 4

/**
 * How long a reservation waits for another request's key, in milliseconds. A request that holds a
 * key is buying a number, which can take longer; this only bounds how long a repeat waits before
 * it is told to try again.
 */
export const IDEMPOTENCY_WAIT_MS = 2000

/** The transaction behind a scope, so a write that must commit with its key can join it. */
const transactions = new WeakMap<IdempotencyScope, Transaction>()

/** The transaction an {@link IdempotencyScope} of this adapter runs in; `undefined` for any other scope. */
export function transactionOf(scope: IdempotencyScope): Transaction | undefined {
  return transactions.get(scope)
}

/** The Postgres error code of a failure, however the driver wraps it. */
function codeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      return current.code
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined
  }
  return undefined
}

/** The primary-key condition of one idempotency row. */
function rowOf(organizationId: string, ref: IdempotencyKeyRef) {
  return sql`organization_id = ${organizationId} and user_id = ${ref.userId}
    and route = ${ref.route} and key = ${ref.key}`
}

/**
 * The statement behind `purge`: one batch of an Organization's keys created before `before`,
 * oldest first, read from `idempotency_keys_purge_idx`. `for update skip locked` makes the purge
 * pass over a row another transaction holds instead of waiting for it. Exported so the
 * integration suite can ask the database for its plan.
 */
export function purgeQuery(organizationId: string, before: Date, limit: number) {
  return sql`
    delete from voice.idempotency_keys
    where ctid = any (array(
      select ctid from voice.idempotency_keys
      where organization_id = ${organizationId} and created_at < ${before.toISOString()}::timestamptz
      order by created_at
      limit ${limit}
      for update skip locked
    ))
    returning 1 as removed
  `
}

function createScope(tx: Transaction, organizationId: string, waitMs: number): IdempotencyScope {
  const scope: IdempotencyScope = {
    async reserve(request) {
      // Bounds every wait of this call, the one for another request's key included. Transaction-local.
      await tx.execute(sql.raw(`set local lock_timeout = ${Math.trunc(waitMs)}`))
      const inProgress = () => new IdempotencyInProgressError(Math.max(1, Math.ceil(waitMs / 1000)))
      try {
        for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
          // Waits, when the key is being inserted by an open transaction, until that one ends.
          const inserted = await tx.execute(sql`
            insert into voice.idempotency_keys
              (organization_id, user_id, route, key, request_hash, created_at)
            values (${organizationId}, ${request.userId}, ${request.route}, ${request.key},
              decode(${request.requestHash}, 'hex'), ${request.now.toISOString()}::timestamptz)
            on conflict (organization_id, user_id, route, key) do nothing
            returning 1 as reserved
          `)
          if (inserted.rows.length > 0) {
            return { outcome: 'reserved' } satisfies IdempotencyReservation
          }
          const found = await tx.execute<{
            status: number | null
            response: unknown
            same: boolean
            expired: boolean
          }>(sql`
            select status, response,
              request_hash = decode(${request.requestHash}, 'hex') as same,
              created_at < ${request.expiredBefore.toISOString()}::timestamptz as expired
            from voice.idempotency_keys
            where ${rowOf(organizationId, request)}
          `)
          const row = found.rows[0]
          if (!row) {
            continue
          }
          if (row.expired) {
            // Counts as absent: take it out and claim the key. A concurrent replacer that got
            // there first leaves a live row, which the next pass reads.
            await tx.execute(sql`
              delete from voice.idempotency_keys
              where ${rowOf(organizationId, request)}
                and created_at < ${request.expiredBefore.toISOString()}::timestamptz
            `)
            continue
          }
          if (row.status === null) {
            // The service never commits an in-flight row; one seen here is not ours to answer from.
            break
          }
          return row.same
            ? ({ outcome: 'replay', status: row.status, response: row.response } as const)
            : ({ outcome: 'reused' } as const)
        }
      } catch (error) {
        if (codeOf(error) === LOCK_NOT_AVAILABLE) {
          throw inProgress()
        }
        throw error
      }
      throw inProgress()
    },

    async complete(ref, status, response) {
      const done = await tx.execute(sql`
        update voice.idempotency_keys
        set status = ${status}, response = ${JSON.stringify(response)}::jsonb
        where ${rowOf(organizationId, ref)} and status is null
        returning 1 as completed
      `)
      if (done.rows.length === 0) {
        throw new Error('The idempotency key is not in flight')
      }
    },

    async remove(ref) {
      const gone = await tx.execute(sql`
        delete from voice.idempotency_keys
        where ${rowOf(organizationId, ref)}
        returning 1 as removed
      `)
      return gone.rows.length > 0
    },

    async purge(before, limit) {
      // In a savepoint: a statement that fails must not abort the write it follows.
      const gone = await tx.transaction((savepoint) =>
        savepoint.execute(purgeQuery(organizationId, before, limit))
      )
      return gone.rows.length
    },
  }
  transactions.set(scope, tx)
  return scope
}

/** Options for {@link createPostgresIdempotencyStore}. */
export type PostgresIdempotencyOptions = {
  /** How long a repeat waits for a held key; defaults to {@link IDEMPOTENCY_WAIT_MS}. */
  waitMs?: number
}

/**
 * The Postgres {@link IdempotencyStore} over `voice.idempotency_keys`: every statement runs inside
 * `withOrganization`, so row-level security confines it to the caller's Organization on top of the
 * explicit filter.
 */
export function createPostgresIdempotencyStore(
  db: Database,
  options: PostgresIdempotencyOptions = {}
): IdempotencyStore {
  const waitMs = options.waitMs ?? IDEMPOTENCY_WAIT_MS
  return {
    withOrganization: (organizationId, fn) =>
      withOrganization(db, organizationId, (tx) => fn(createScope(tx, organizationId, waitMs))),
  }
}
