import { sql } from 'drizzle-orm'
import { type Database, type Transaction, withOrganization } from 'tula-closeline-db'

/** Rows removed per statement; keeps each statement short and its locks brief. */
export const TWILIO_PURGE_BATCH_SIZE = 500
/** Statements per table per run; a run is bounded even if an Organization has a deep backlog. */
export const TWILIO_PURGE_MAX_BATCHES = 20

/** What one {@link purgeExpiredTwilio} run did. */
export type TwilioPurgeResult = {
  /** Call records removed (their Recording rows go with them, by cascade). */
  calls: number
  /** Placements removed. */
  placements: number
  /** False when the cap stopped the run with expired rows possibly left; run again. */
  drained: boolean
}

/** Options for {@link purgeExpiredTwilio}. */
export type TwilioPurgeOptions = {
  /** Rows with `expires_at` at or before this go; defaults to the current time. */
  now?: Date
  /** Rows per statement; defaults to {@link TWILIO_PURGE_BATCH_SIZE}. */
  batchSize?: number
  /** Statements per table; defaults to {@link TWILIO_PURGE_MAX_BATCHES}. */
  maxBatches?: number
}

type PurgeTable = 'twilio_calls' | 'twilio_placements'

/**
 * One batch of an Organization's expired rows, read from the table's `(organization_id,
 * expires_at)` purge index. For calls, `for update skip locked` passes over a row another
 * transaction holds (`withCall`); placements cannot take it (the service role has no UPDATE on
 * them, and `for update` needs it), but they are written once and never locked, so a plain read
 * is enough.
 */
function purgeQuery(table: PurgeTable, organizationId: string, now: Date, limit: number) {
  const target = sql.raw(`voice.${table}`)
  const lock = table === 'twilio_calls' ? sql`for update skip locked` : sql``
  return sql`
    delete from ${target}
    where ctid = any (array(
      select ctid from ${target}
      where organization_id = ${organizationId} and expires_at <= ${now.toISOString()}::timestamptz
      order by expires_at
      limit ${limit}
      ${lock}
    ))
    returning 1 as removed
  `
}

/** Runs batches against one table until one removes nothing or the cap is reached. */
async function purgeTable(
  db: Database,
  table: PurgeTable,
  organizationId: string,
  now: Date,
  batchSize: number,
  maxBatches: number
): Promise<{ removed: number; drained: boolean }> {
  let removed = 0
  for (let batch = 0; batch < maxBatches; batch += 1) {
    // One short transaction per batch, each scoped to the Organization.
    const gone = await withOrganization(db, organizationId, (tx: Transaction) =>
      tx.execute(purgeQuery(table, organizationId, now, batchSize))
    )
    removed += gone.rows.length
    if (gone.rows.length === 0) {
      return { removed, drained: true }
    }
  }
  return { removed, drained: false }
}

/**
 * Removes one Organization's expired Twilio call records and placements in bounded batches, always
 * under `withOrganization`, so row-level security confines it to that Organization. A run stops
 * after `maxBatches` statements per table and reports `drained: false`; a batch that removes
 * nothing is the only proof of an empty backlog (a row another session holds is skipped).
 * Recording rows are not matched by expiry: they go only with their call. The caller supplies the
 * Organization.
 */
export async function purgeExpiredTwilio(
  db: Database,
  organizationId: string,
  options: TwilioPurgeOptions = {}
): Promise<TwilioPurgeResult> {
  const batchSize = options.batchSize ?? TWILIO_PURGE_BATCH_SIZE
  const maxBatches = options.maxBatches ?? TWILIO_PURGE_MAX_BATCHES
  if (
    !(
      Number.isInteger(batchSize) &&
      batchSize > 0 &&
      Number.isInteger(maxBatches) &&
      maxBatches > 0
    )
  ) {
    throw new RangeError('purgeExpiredTwilio: batchSize and maxBatches must be positive integers')
  }
  const now = options.now ?? new Date()
  const calls = await purgeTable(db, 'twilio_calls', organizationId, now, batchSize, maxBatches)
  const placements = await purgeTable(
    db,
    'twilio_placements',
    organizationId,
    now,
    batchSize,
    maxBatches
  )
  return {
    calls: calls.removed,
    placements: placements.removed,
    drained: calls.drained && placements.drained,
  }
}
