import { describe, expect, test } from 'bun:test'
import { createFixedClock, createLogger } from 'tula-closeline-kit'
import { createMemoryTwilioPurgeSource } from '~/adapters/memory/twilio-purge-source'
import type { TwilioPurgeSource } from '~/ports/twilio-purge-source'
import { boundTwilioPurgeSource, PurgeQueryTimeoutError } from './bound-source'
import { startSchedule } from './schedule'
import { runTwilioPurge } from './twilio-purge-job'

/** A source whose first `hangs` calls (scan or purge) never settle. */
function hangingSource(hangs: number): TwilioPurgeSource {
  const inner = createMemoryTwilioPurgeSource([['org_a', 1]])
  let calls = 0
  const gate = <T>(real: () => Promise<T>): Promise<T> => {
    calls += 1
    return calls <= hangs ? new Promise<T>(() => {}) : real()
  }
  return {
    organizationsWithExpired: (now, after, limit) =>
      gate(() => inner.organizationsWithExpired(now, after, limit)),
    purge: (id, now) => gate(() => inner.purge(id, now)),
  }
}

const depsFor = (source: TwilioPurgeSource, errors: unknown[]) => ({
  source,
  clock: createFixedClock('2026-01-01T00:00:00Z'),
  logger: createLogger({ service: 'voice', level: 'error', destination: { write: () => {} } }),
  reportError: (error: unknown) => void errors.push(error),
})

describe('boundTwilioPurgeSource', () => {
  test('a hung scan rejects with a timeout error instead of waiting forever', async () => {
    const bound = boundTwilioPurgeSource(hangingSource(1), 20)
    const started = Date.now()
    await expect(bound.organizationsWithExpired(new Date(), null, 10)).rejects.toBeInstanceOf(
      PurgeQueryTimeoutError
    )
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('a hung purge rejects with a timeout error', async () => {
    const bound = boundTwilioPurgeSource(hangingSource(1), 20)
    await expect(bound.purge('org_a', new Date())).rejects.toBeInstanceOf(PurgeQueryTimeoutError)
  })

  test('a purge slower than one timeout but within its two-statement budget is not cut off', async () => {
    const slow: TwilioPurgeSource = {
      organizationsWithExpired: async () => [],
      purge: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return { calls: 1, placements: 0, drained: true }
      },
    }
    const bound = boundTwilioPurgeSource(slow, 50)
    expect(await bound.purge('org_a', new Date())).toMatchObject({ calls: 1 })
  })

  test('a fast query passes through unchanged', async () => {
    const bound = boundTwilioPurgeSource(createMemoryTwilioPurgeSource([['org_a', 2]]), 1_000)
    expect(await bound.organizationsWithExpired(new Date(), null, 10)).toEqual(['org_a'])
    expect(await bound.purge('org_a', new Date())).toMatchObject({ calls: 2 })
  })

  test('a timed-out query is reported and counted, and the next run works', async () => {
    const errors: unknown[] = []
    const deps = depsFor(boundTwilioPurgeSource(hangingSource(2), 20), errors)
    // The first two queries (the scans of the first two runs) hang; the third run is clean.
    expect(await runTwilioPurge(deps, { maxOrganizations: 10 })).toMatchObject({ scanFailed: true })
    expect(errors[0]).toBeInstanceOf(PurgeQueryTimeoutError)
    expect(await runTwilioPurge(deps, { maxOrganizations: 10 })).toMatchObject({ scanFailed: true })
    expect(await runTwilioPurge(deps, { maxOrganizations: 10 })).toMatchObject({
      organizations: 1,
      calls: 1,
      failed: 0,
    })
    expect(errors).toHaveLength(2)
  })

  test('a timed-out purge fails one Organization and the next run purges it', async () => {
    const errors: unknown[] = []
    const inner = createMemoryTwilioPurgeSource([['org_a', 1]])
    let purges = 0
    const source: TwilioPurgeSource = {
      organizationsWithExpired: inner.organizationsWithExpired,
      purge: (id, now) => {
        purges += 1
        return purges === 1 ? new Promise(() => {}) : inner.purge(id, now)
      },
    }
    const deps = depsFor(boundTwilioPurgeSource(source, 20), errors)
    expect(await runTwilioPurge(deps, { maxOrganizations: 10 })).toMatchObject({ failed: 1 })
    expect(errors[0]).toBeInstanceOf(PurgeQueryTimeoutError)
    expect(await runTwilioPurge(deps, { maxOrganizations: 10 })).toMatchObject({
      calls: 1,
      failed: 0,
    })
  })

  test('stopping the schedule waits for at most the bounded in-flight run', async () => {
    const errors: unknown[] = []
    const deps = depsFor(boundTwilioPurgeSource(hangingSource(1_000), 30), errors)
    let fire: (() => void) | undefined
    const schedule = startSchedule({
      run: (isStopped) => runTwilioPurge(deps, { maxOrganizations: 10, shouldStop: isStopped }),
      onError: (e) => void errors.push(e),
      intervalMs: 1_000,
      setTimer: (callback) => {
        fire = callback
        return 1
      },
      clearTimer: () => {},
    })
    fire?.() // a run starts and its scan hangs
    const started = Date.now()
    await schedule.stop()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(errors[0]).toBeInstanceOf(PurgeQueryTimeoutError)
  })
})
