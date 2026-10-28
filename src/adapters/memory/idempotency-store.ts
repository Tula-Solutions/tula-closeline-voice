import {
  IdempotencyInProgressError,
  type IdempotencyKeyRef,
  type IdempotencyScope,
  type IdempotencyStore,
} from '~/ports/idempotency-store'

/** What an in-flight caller is told to wait, in seconds. */
const RETRY_AFTER_SECONDS = 1

/** `status` is null while the request that holds the key is still running (committed in flight). */
type Row = { requestHash: string; createdAt: Date; status: number | null; response: unknown }

/** The in-memory store plus what a test asserts on. */
export type MemoryIdempotencyStore = IdempotencyStore & {
  /** How many keys (completed ones) an Organization has stored. */
  count: (organizationId: string) => number
}

const rowKey = (organizationId: string, ref: IdempotencyKeyRef): string =>
  JSON.stringify([organizationId, ref.userId, ref.route, ref.key])

/**
 * An in-memory {@link IdempotencyStore} for tests and local runs. A transaction's changes show only
 * when it commits; a key another open transaction holds, or one committed in flight, answers
 * in-progress at once instead of waiting.
 */
export function createMemoryIdempotencyStore(): MemoryIdempotencyStore {
  const committed = new Map<string, Row & { organizationId: string }>()
  const inFlight = new Set<string>()

  return {
    count: (organizationId) =>
      [...committed.values()].filter(
        (row) => row.organizationId === organizationId && row.status !== null
      ).length,

    async withOrganization(organizationId, fn) {
      const reserved = new Map<string, { requestHash: string; createdAt: Date }>()
      const completed = new Map<string, Row>()
      const removed = new Set<string>()

      /** A key committed in flight by an earlier transaction, which this one may complete. */
      const held = (at: string) => {
        const row = committed.get(at)
        return row !== undefined && row.status === null ? row : undefined
      }

      const scope: IdempotencyScope = {
        async reserve(request) {
          const at = rowKey(organizationId, request)
          if (inFlight.has(at)) {
            throw new IdempotencyInProgressError(RETRY_AFTER_SECONDS)
          }
          const existing = committed.get(at)
          if (existing !== undefined && !removed.has(at)) {
            if (existing.createdAt >= request.expiredBefore) {
              if (existing.status === null) {
                throw new IdempotencyInProgressError(RETRY_AFTER_SECONDS)
              }
              return existing.requestHash === request.requestHash
                ? { outcome: 'replay', status: existing.status, response: existing.response }
                : { outcome: 'reused' }
            }
            removed.add(at)
          }
          inFlight.add(at)
          reserved.set(at, { requestHash: request.requestHash, createdAt: request.now })
          return { outcome: 'reserved' }
        },

        async complete(ref, status, response) {
          const at = rowKey(organizationId, ref)
          const row = reserved.get(at) ?? held(at)
          if (row === undefined || completed.has(at)) {
            throw new Error('The idempotency key is not in flight')
          }
          completed.set(at, { ...row, status, response: structuredClone(response) })
        },

        async remove(ref) {
          const at = rowKey(organizationId, ref)
          if (reserved.delete(at)) {
            inFlight.delete(at)
            completed.delete(at)
            return true
          }
          if (committed.has(at) && !removed.has(at)) {
            removed.add(at)
            return true
          }
          return false
        },

        async purge(before, limit) {
          const doomed = [...committed.entries()]
            .filter(
              ([at, row]) =>
                row.organizationId === organizationId && row.createdAt < before && !removed.has(at)
            )
            .sort(([, a], [, b]) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, limit)
          for (const [at] of doomed) {
            removed.add(at)
          }
          return doomed.length
        },
      }

      try {
        const result = await fn(scope)
        for (const at of removed) {
          committed.delete(at)
        }
        for (const [at, row] of reserved) {
          if (!completed.has(at)) {
            committed.set(at, { ...row, status: null, response: null, organizationId })
          }
        }
        for (const [at, row] of completed) {
          committed.set(at, { ...row, organizationId })
        }
        return result
      } finally {
        for (const at of reserved.keys()) {
          inFlight.delete(at)
        }
      }
    },
  }
}
