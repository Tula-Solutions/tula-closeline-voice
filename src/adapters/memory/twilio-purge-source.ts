import type { TwilioPurgeSource } from '~/ports/twilio-purge-source'

/** A purge source over a map of Organization id to its count of expired rows, for tests. */
export type MemoryTwilioPurgeSource = TwilioPurgeSource & {
  /** Expired rows per Organization; an Organization is listed while its count is above zero. */
  expired: Map<string, number>
  /** Organizations passed to `purge`, in order. */
  purged: string[]
}

/** Builds the in-memory purge source; `expired` is the starting backlog. */
export function createMemoryTwilioPurgeSource(
  expired: Iterable<[string, number]> = []
): MemoryTwilioPurgeSource {
  const backlog = new Map(expired)
  const purged: string[] = []
  return {
    expired: backlog,
    purged,
    organizationsWithExpired: async (_now, after, limit) =>
      [...backlog.entries()]
        .filter(([id, count]) => count > 0 && (after === null || id > after))
        .map(([id]) => id)
        .sort()
        .slice(0, limit),
    purge: async (organizationId) => {
      purged.push(organizationId)
      const calls = backlog.get(organizationId) ?? 0
      backlog.delete(organizationId)
      return { calls, placements: 0, drained: true }
    },
  }
}
