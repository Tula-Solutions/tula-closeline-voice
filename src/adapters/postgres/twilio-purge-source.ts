import { sql } from 'drizzle-orm'
import type { Database } from 'tula-closeline-db'
import type { TwilioPurgeSource } from '~/ports/twilio-purge-source'
import { purgeExpiredTwilio } from './twilio-purge'

/**
 * The Postgres purge source. The scan is `voice.twilio_orgs_with_expired`, a definer function that
 * returns Organization ids only (row-level security hides every other Organization's rows from the
 * service login); each Organization is then purged under `withOrganization`.
 */
export function createPostgresTwilioPurgeSource(db: Database): TwilioPurgeSource {
  return {
    organizationsWithExpired: async (now, after, limit) => {
      const result = await db.execute<{ organization_id: string }>(
        sql`select organization_id from voice.twilio_orgs_with_expired(${now.toISOString()}::timestamptz, ${after}::text, ${limit}::int)`
      )
      return result.rows.map((row: { organization_id: string }) => row.organization_id)
    },
    purge: (organizationId, now) => purgeExpiredTwilio(db, organizationId, { now }),
  }
}
