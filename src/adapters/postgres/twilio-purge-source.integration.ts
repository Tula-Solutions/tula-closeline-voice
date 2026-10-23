import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createFixedClock, createLogger } from 'tula-closeline-kit'
import { integrationUrls } from '~/integration-support'
import { runTwilioPurge } from '~/modules/purge/twilio-purge-job'
import { createPostgresTwilioPurgeSource } from './twilio-purge-source'
import { createPostgresTwilioStore } from './twilio-store'
import { callRecord, newOrganizationId, newProviderCallId } from './twilio-store.behaviour'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
const store = createPostgresTwilioStore(service.db)
const source = createPostgresTwilioPurgeSource(service.db)

afterAll(async () => {
  await service.close()
  await owner.close()
})

const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString()

/** Stores one call for the Organization and, when `expired`, makes it so. */
async function seedCall(organizationId: string, expired: boolean) {
  await store.putCall(newProviderCallId(), callRecord(organizationId))
  if (expired) {
    await withOrganization(owner.db, organizationId, (tx) =>
      tx.execute(
        sql`update voice.twilio_calls set created_at = ${twoHoursAgo}::timestamptz, expires_at = ${hourAgo}::timestamptz`
      )
    )
  }
}

const remaining = (organizationId: string) =>
  withOrganization(owner.db, organizationId, async (tx) => {
    const r = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from voice.twilio_calls`
    )
    return r.rows[0]?.n
  })

describe('the Postgres purge source', () => {
  test('the job finds Organizations with expired rows through the scan and purges only them', async () => {
    const expired = newOrganizationId()
    const live = newOrganizationId()
    await seedCall(expired, true)
    await seedCall(live, false)

    const found = await source.organizationsWithExpired(new Date(), null, 500)
    expect(found).toContain(expired)
    expect(found).not.toContain(live)

    const lines: string[] = []
    const run = await runTwilioPurge(
      {
        source,
        clock: createFixedClock(new Date().toISOString()),
        logger: createLogger({
          service: 'voice',
          level: 'silent',
          destination: { write: (line) => void lines.push(line) },
        }),
        reportError: (error) => {
          throw error
        },
      },
      { maxOrganizations: 500 }
    )

    expect(run.calls).toBeGreaterThanOrEqual(1)
    expect(run.failed).toBe(0)
    expect(await remaining(expired)).toBe(0)
    expect(await remaining(live)).toBe(1)
  })

  test('pages by cursor', async () => {
    const first = await source.organizationsWithExpired(new Date(), null, 1)
    expect(first.length).toBeLessThanOrEqual(1)
    if (first[0] !== undefined) {
      const next = await source.organizationsWithExpired(new Date(), first[0], 500)
      expect(next).not.toContain(first[0])
    }
  })
})
