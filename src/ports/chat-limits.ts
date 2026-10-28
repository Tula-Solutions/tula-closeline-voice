/** The fixed window of a Chat rate limit, in milliseconds. */
export const CHAT_RATE_WINDOW_MS = 60_000

/** The per-minute request counters of the public Website Chat routes. */
export type ChatRateLimiter = {
  /**
   * Counts one request against `keyHash` (an HMAC of what is limited, never the value) in the
   * minute `now` falls in, for the Organization, and answers whether it is within `limit`. The
   * count is shared by every instance. A request over the limit is still counted.
   */
  hit: (organizationId: string, keyHash: Uint8Array, now: Date, limit: number) => Promise<boolean>
}
