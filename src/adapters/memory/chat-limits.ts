import { CHAT_RATE_WINDOW_MS, type ChatRateLimiter } from '~/ports/chat-limits'

/** Chat rate counters held in memory, for tests and local runs. */
export function createMemoryChatRateLimiter(): ChatRateLimiter {
  const counts = new Map<string, number>()
  return {
    async hit(organizationId, keyHash, now, limit) {
      const window = Math.floor(now.getTime() / CHAT_RATE_WINDOW_MS)
      const at = `${organizationId}:${Buffer.from(keyHash).toString('hex')}:${window}`
      const hits = (counts.get(at) ?? 0) + 1
      counts.set(at, hits)
      return hits <= limit
    },
  }
}
