import { sql } from 'drizzle-orm'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceChatRateCounters } from 'tula-closeline-db/schema'
import { CHAT_RATE_WINDOW_MS, type ChatRateLimiter } from '~/ports/chat-limits'

/** Counters older than this are removed; a window is only read while it is current. */
const KEEP_MS = 60 * 60 * 1000
/** The most old counters one request removes. */
const PURGE_BATCH = 100

/**
 * The {@link ChatRateLimiter} over `voice.chat_rate_counters`: one upsert per request, so
 * concurrent requests on any instance serialise on the row. The first hit of a new window also
 * removes one bounded batch of the Organization's old rows.
 */
export function createPostgresChatRateLimiter(db: Database): ChatRateLimiter {
  return {
    hit: (organizationId, keyHash, now, limit) =>
      withOrganization(db, organizationId, async (tx) => {
        const windowStart = new Date(
          Math.floor(now.getTime() / CHAT_RATE_WINDOW_MS) * CHAT_RATE_WINDOW_MS
        )
        const [row] = await tx
          .insert(voiceChatRateCounters)
          .values({ organizationId, keyHash, windowStart, hits: 1 })
          .onConflictDoUpdate({
            target: [
              voiceChatRateCounters.organizationId,
              voiceChatRateCounters.keyHash,
              voiceChatRateCounters.windowStart,
            ],
            set: { hits: sql`${voiceChatRateCounters.hits} + 1` },
          })
          .returning({ hits: voiceChatRateCounters.hits })
        if (row?.hits === 1) {
          const before = new Date(windowStart.getTime() - KEEP_MS).toISOString()
          await tx.execute(sql`
            delete from voice.chat_rate_counters where ctid = any (array(
              select ctid from voice.chat_rate_counters
              where organization_id = ${organizationId} and window_start < ${before}::timestamptz
              limit ${PURGE_BATCH}))
          `)
        }
        return (row?.hits ?? 1) <= limit
      }),
  }
}
