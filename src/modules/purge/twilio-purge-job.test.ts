import { describe, expect, test } from 'bun:test'
import { createFixedClock, createLogger } from 'tula-closeline-kit'
import { createMemoryTwilioPurgeSource } from '~/adapters/memory/twilio-purge-source'
import { TWILIO_PURGE_PAGE_SIZE, type TwilioPurgeSource } from '~/ports/twilio-purge-source'
import { runTwilioPurge } from './twilio-purge-job'

function setup(source: TwilioPurgeSource) {
  const errors: unknown[] = []
  const lines: string[] = []
  return {
    errors,
    lines,
    deps: {
      source,
      clock: createFixedClock('2026-01-01T00:00:00Z'),
      logger: createLogger({
        service: 'voice',
        level: 'debug',
        destination: { write: (line) => void lines.push(line) },
      }),
      reportError: (error: unknown) => void errors.push(error),
    },
  }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `org_${String(i).padStart(4, '0')}`)

describe('runTwilioPurge', () => {
  test('purges every Organization with expired rows and nothing else', async () => {
    const source = createMemoryTwilioPurgeSource([
      ['org_a', 2],
      ['org_b', 0],
      ['org_c', 3],
    ])
    const { deps } = setup(source)
    const run = await runTwilioPurge(deps, { maxOrganizations: 10 })
    expect(source.purged).toEqual(['org_a', 'org_c'])
    expect(run).toMatchObject({ organizations: 2, calls: 5, failed: 0, capped: false })
    expect(await runTwilioPurge(deps, { maxOrganizations: 10 })).toMatchObject({ organizations: 0 })
  })

  test('pages past one page of Organizations', async () => {
    const all = ids(TWILIO_PURGE_PAGE_SIZE + 30)
    const source = createMemoryTwilioPurgeSource(all.map((id) => [id, 1]))
    const run = await runTwilioPurge(setup(source).deps, { maxOrganizations: 1000 })
    expect(run.organizations).toBe(all.length)
    expect(source.purged).toEqual(all)
  })

  test('stops at the per-run cap and picks the rest up on the next run', async () => {
    const source = createMemoryTwilioPurgeSource(ids(5).map((id) => [id, 1]))
    const { deps } = setup(source)
    const first = await runTwilioPurge(deps, { maxOrganizations: 3 })
    expect(first).toMatchObject({ organizations: 3, capped: true })
    const second = await runTwilioPurge(deps, { maxOrganizations: 3 })
    expect(second).toMatchObject({ organizations: 2, capped: false })
  })

  test('an exact fit is not reported as capped', async () => {
    const source = createMemoryTwilioPurgeSource(ids(3).map((id) => [id, 1]))
    const run = await runTwilioPurge(setup(source).deps, { maxOrganizations: 3 })
    expect(run).toMatchObject({ organizations: 3, capped: false })
  })

  test('one Organization failing is reported and the others still run', async () => {
    const inner = createMemoryTwilioPurgeSource([
      ['org_a', 1],
      ['org_b', 1],
      ['org_c', 1],
    ])
    const source: TwilioPurgeSource = {
      ...inner,
      purge: async (id, now) => {
        if (id === 'org_b') {
          throw new Error('db down')
        }
        return inner.purge(id, now)
      },
    }
    const { deps, errors } = setup(source)
    const run = await runTwilioPurge(deps, { maxOrganizations: 10 })
    expect(run).toMatchObject({ organizations: 3, failed: 1, calls: 2 })
    expect(errors).toHaveLength(1)
  })

  test('a failing scan is reported and ends the run without throwing', async () => {
    const source: TwilioPurgeSource = {
      organizationsWithExpired: async () => {
        throw new Error('scan down')
      },
      purge: async () => ({ calls: 0, placements: 0, drained: true }),
    }
    const { deps, errors } = setup(source)
    const run = await runTwilioPurge(deps, { maxOrganizations: 10 })
    expect(run.scanFailed).toBe(true)
    expect(errors).toHaveLength(1)
  })

  test('counts Organizations a batch cap left undrained', async () => {
    const source: TwilioPurgeSource = {
      organizationsWithExpired: async (_now, after) => (after === null ? ['org_a'] : []),
      purge: async () => ({ calls: 10, placements: 0, drained: false }),
    }
    const run = await runTwilioPurge(setup(source).deps, { maxOrganizations: 10 })
    expect(run.undrained).toBe(1)
  })

  test('logs the counts and no Organization id', async () => {
    const { deps, lines } = setup(createMemoryTwilioPurgeSource([['org_secretish', 1]]))
    await runTwilioPurge(deps, { maxOrganizations: 10 })
    expect(lines.join('')).toContain('twilio purge run')
    expect(lines.join('')).not.toContain('org_secretish')
  })
})

describe('runTwilioPurge fairness and stopping', () => {
  test('resuming from the returned cursor reaches Organizations behind ones that keep failing', async () => {
    const inner = createMemoryTwilioPurgeSource([
      ['org_a', 1],
      ['org_b', 1],
      ['org_c', 1],
    ])
    const source: TwilioPurgeSource = {
      ...inner,
      purge: async (id, now) => {
        if (id === 'org_a' || id === 'org_b') {
          throw new Error('stuck')
        }
        return inner.purge(id, now)
      },
    }
    const { deps } = setup(source)
    let after: string | null = null
    for (let i = 0; i < 3; i += 1) {
      const run = await runTwilioPurge(deps, { maxOrganizations: 2, after })
      after = run.next
    }
    expect(inner.purged).toEqual(['org_c'])
  })

  test('shouldStop ends the run between Organizations', async () => {
    const source = createMemoryTwilioPurgeSource(ids(5).map((id) => [id, 1]))
    let calls = 0
    const run = await runTwilioPurge(setup(source).deps, {
      maxOrganizations: 10,
      shouldStop: () => {
        calls += 1
        return calls > 2
      },
    })
    expect(run).toMatchObject({ stopped: true, organizations: 2 })
    expect(source.purged).toHaveLength(2)
  })
})
