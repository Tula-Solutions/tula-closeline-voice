import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { purgeExpiredTwilio } from './twilio-purge'
import { createPostgresTwilioStore } from './twilio-store'
import { callRecord, newOrganizationId, newProviderCallId } from './twilio-store.behaviour'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
const store = createPostgresTwilioStore(service.db)

afterAll(async () => {
  await service.close()
  await owner.close()
})

const NOW = new Date()
const hourAgo = new Date(NOW.getTime() - 3_600_000).toISOString()
const twoHoursAgo = new Date(NOW.getTime() - 7_200_000).toISOString()

/** Stores `calls` calls and `placements` placements for an Organization and expires them all. */
async function seedExpired(organizationId: string, calls: number, placements: number) {
  const ids: string[] = []
  for (let i = 0; i < calls; i += 1) {
    const id = newProviderCallId()
    ids.push(id)
    await store.putCall(id, callRecord(organizationId))
  }
  for (let i = 0; i < placements; i += 1) {
    await store.putPlacement(organizationId, `key-${i}`, {
      providerCallId: ids[0] ?? newProviderCallId(),
      fingerprint: 'f',
    })
  }
  await withOrganization(owner.db, organizationId, async (tx) => {
    await tx.execute(
      sql`update voice.twilio_calls set created_at = ${twoHoursAgo}::timestamptz, expires_at = ${hourAgo}::timestamptz`
    )
    await tx.execute(
      sql`update voice.twilio_placements set created_at = ${twoHoursAgo}::timestamptz, expires_at = ${hourAgo}::timestamptz`
    )
  })
  return ids
}

const counts = (organizationId: string) =>
  withOrganization(owner.db, organizationId, async (tx) => {
    const r = await tx.execute<{ calls: number; placements: number }>(sql`select
      (select count(*)::int from voice.twilio_calls) as calls,
      (select count(*)::int from voice.twilio_placements) as placements`)
    return r.rows[0]
  })

describe('purgeExpiredTwilio', () => {
  test('removes expired calls and placements and keeps unexpired ones', async () => {
    const org = newOrganizationId()
    await seedExpired(org, 3, 2)
    const live = newProviderCallId()
    await store.putCall(live, callRecord(org))
    await store.putPlacement(org, 'live', { providerCallId: live, fingerprint: 'f' })

    const result = await purgeExpiredTwilio(service.db, org, { now: NOW })

    expect(result).toEqual({ calls: 3, placements: 2, drained: true })
    expect(await counts(org)).toEqual({ calls: 1, placements: 1 })
    expect(await store.getCall(live)).not.toBeNull()
  })

  test('stops at the batch cap and reports that more remain, then finishes on the next run', async () => {
    const org = newOrganizationId()
    await seedExpired(org, 5, 0)

    const first = await purgeExpiredTwilio(service.db, org, {
      now: NOW,
      batchSize: 2,
      maxBatches: 2,
    })
    expect(first).toEqual({ calls: 4, placements: 0, drained: false })
    expect((await counts(org))?.calls).toBe(1)

    const second = await purgeExpiredTwilio(service.db, org, {
      now: NOW,
      batchSize: 2,
      maxBatches: 2,
    })
    expect(second).toEqual({ calls: 1, placements: 0, drained: true })
  })

  test('never touches another Organization, expired or not', async () => {
    const a = newOrganizationId()
    const b = newOrganizationId()
    await seedExpired(a, 2, 2)
    await seedExpired(b, 2, 2)

    await purgeExpiredTwilio(service.db, a, { now: NOW })

    expect(await counts(a)).toEqual({ calls: 0, placements: 0 })
    expect(await counts(b)).toEqual({ calls: 2, placements: 2 })
  })

  test('a call purge also drops its directory entry so the id can be reused', async () => {
    const org = newOrganizationId()
    const [id] = await seedExpired(org, 1, 0)
    await purgeExpiredTwilio(service.db, org, { now: NOW })
    expect(await store.getCall(id as string)).toBeNull()
  })

  test('a call locked by withCall is skipped and the run is not reported drained', async () => {
    const org = newOrganizationId()
    const [id] = await seedExpired(org, 1, 0)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked: () => void = () => {}
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve
    })
    const holder = store.withCall(id as string, async () => {
      locked()
      await held
    })
    await lockTaken
    const during = await purgeExpiredTwilio(service.db, org, { now: NOW })
    expect(during).toEqual({ calls: 0, placements: 0, drained: false })
    release()
    await holder
    expect(await purgeExpiredTwilio(service.db, org, { now: NOW })).toEqual({
      calls: 1,
      placements: 0,
      drained: true,
    })
  })

  test('row-level security alone confines a statement run under another Organization scope', async () => {
    const a = newOrganizationId()
    const b = newOrganizationId()
    await seedExpired(b, 1, 1)
    const removed = await withOrganization(service.db, a, (tx) =>
      tx.execute(sql`delete from voice.twilio_calls where organization_id = ${b} returning 1`)
    )
    expect(removed.rows.length).toBe(0)
    expect(await counts(b)).toEqual({ calls: 1, placements: 1 })
  })

  test('rejects a non-positive batch size or cap', async () => {
    const org = newOrganizationId()
    await expect(purgeExpiredTwilio(service.db, org, { batchSize: 0 })).rejects.toThrow()
    await expect(purgeExpiredTwilio(service.db, org, { maxBatches: 0 })).rejects.toThrow()
  })
})
