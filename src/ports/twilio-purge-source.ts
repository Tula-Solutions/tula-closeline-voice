import type { TwilioPurgeResult } from '~/adapters/postgres/twilio-purge'

/** The most Organizations one page of {@link TwilioPurgeSource.organizationsWithExpired} returns. */
export const TWILIO_PURGE_PAGE_SIZE = 100

/** Where the purge job finds Organizations with expired Twilio rows and clears them. */
export type TwilioPurgeSource = {
  /**
   * Up to `limit` Organization ids, ascending and strictly after `after` (null starts at the
   * beginning), that hold a Twilio row expiring at or before `now`.
   */
  organizationsWithExpired: (now: Date, after: string | null, limit: number) => Promise<string[]>
  /** Removes one Organization's expired rows in bounded batches; safe to repeat. */
  purge: (organizationId: string, now: Date) => Promise<TwilioPurgeResult>
}
