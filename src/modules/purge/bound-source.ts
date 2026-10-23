import type { TwilioPurgeSource } from '~/ports/twilio-purge-source'

/** Thrown when a purge-source query outlives `TWILIO_PURGE_QUERY_TIMEOUT_MS`. */
export class PurgeQueryTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`twilio purge ${operation} exceeded ${timeoutMs} ms`)
    this.name = 'PurgeQueryTimeoutError'
  }
}

/** Settles with `work`, or rejects with a {@link PurgeQueryTimeoutError} after `timeoutMs`. */
function within<T>(operation: string, timeoutMs: number, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PurgeQueryTimeoutError(operation, timeoutMs)),
      timeoutMs
    )
    work().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Wraps a purge source so each scan settles within `timeoutMs` and each purge within twice that: a hung one rejects, which the job
 * reports and counts, so a run (and therefore shutdown) never waits on it. The Postgres source also
 * cancels the statement server-side; this is the bound for any source that cannot.
 */
export function boundTwilioPurgeSource(
  source: TwilioPurgeSource,
  timeoutMs: number
): TwilioPurgeSource {
  return {
    organizationsWithExpired: (now, after, limit) =>
      within('scan', timeoutMs, () => source.organizationsWithExpired(now, after, limit)),
    purge: (organizationId, now) =>
      // A purge is several statements: no new one starts after `timeoutMs` and the last may run
      // `timeoutMs` more, so its bound is twice that.
      within('purge', timeoutMs * 2, () => source.purge(organizationId, now)),
  }
}
