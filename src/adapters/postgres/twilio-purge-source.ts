import { sql } from 'drizzle-orm'
import type { Database } from 'tula-closeline-db'
import type { TwilioPurgeSource } from '~/ports/twilio-purge-source'
import { purgeExpiredTwilio, setLocalStatementTimeout } from './twilio-purge'

/**
 * The Postgres purge source. The scan is `voice.twilio_orgs_with_expired`, a definer function that
 * returns Organization ids only (row-level security hides every other Organization's rows from the
 * service login); each Organization is then purged under `withOrganization`. With `queryTimeoutMs`
 * every statement is capped at it by a transaction-local `statement_timeout`, so Postgres cancels it.
 */
export function createPostgresTwilioPurgeSource(
  db: Database,
  queryTimeoutMs?: number
): TwilioPurgeSource {
  return {
    organizationsWithExpired: async (now, after, limit) => {
      const scan = sql`select organization_id from voice.twilio_orgs_with_expired(${now.toISOString()}::timestamptz, ${after}::text, ${limit}::int)`
      const result =
        queryTimeoutMs === undefined
          ? await db.execute<{ organization_id: string }>(scan)
          : await db.transaction(async (tx) => {
              await setLocalStatementTimeout(tx, queryTimeoutMs)
              return tx.execute<{ organization_id: string }>(scan)
            })
      return result.rows.map((row: { organization_id: string }) => row.organization_id)
    },
    purge: (organizationId, now) =>
      purgeExpiredTwilio(db, organizationId, {
        now,
        statementTimeoutMs: queryTimeoutMs,
        // No new batch after one timeout's worth, so a deep backlog ends the run (drained: false)
        // instead of outliving the caller's bound; the next run continues.
        ...(queryTimeoutMs === undefined ? {} : { deadline: Date.now() + queryTimeoutMs }),
      }),
  }
}
