import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { formatId, type OrganizationId, type UserId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { IdempotencyInProgressError } from '~/ports/idempotency-store'
import { createPostgresIdempotencyStore } from './idempotency-store'
import { createPostgresLineStore } from './line-store'

const urls = integrationUrls()
const { db, close } = createDb(urls.service)
const owner = createDb(urls.owner)
const store = createPostgresIdempotencyStore(db, { waitMs: 300 })
const lines = createPostgresLineStore(db)

afterAll(async () => {
  await close()
  await owner.close()
})

const newOrganization = (): OrganizationId => formatId('org', crypto.randomUUID())
const newUser = (): UserId => formatId('usr', crypto.randomUUID())
const hash = (seed: string): string => new Bun.CryptoHasher('sha256').update(seed).digest('hex')

const NOW = new Date('2026-01-02T00:00:00.000Z')
const DAY_AGO = new Date('2026-01-01T00:00:00.000Z')

function request(userId: UserId, key: string, seed = 'a', now = NOW) {
  return { userId, route: 'lines.add', key, requestHash: hash(seed), now, expiredBefore: DAY_AGO }
}

/** How many keys the Organization has, counted through the owner login and the Organization's own scope. */
const count = async (org: OrganizationId): Promise<number> => {
  const rows = await withOrganization(owner.db, org, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from voice.idempotency_keys`)
  )
  return rows.rows[0]?.n ?? 0
}

describe('the Postgres idempotency store', () => {
  test('reserves, completes and replays a key, and refuses another request on it', async () => {
    const org = newOrganization()
    const user = newUser()
    const key = `key-${crypto.randomUUID()}`
    await store.withOrganization(org, async (scope) => {
      expect(await scope.reserve(request(user, key))).toEqual({ outcome: 'reserved' })
      await scope.complete({ userId: user, route: 'lines.add', key }, 201, { id: 'line_1' })
    })
    await store.withOrganization(org, async (scope) => {
      expect(await scope.reserve(request(user, key))).toEqual({
        outcome: 'replay',
        status: 201,
        response: { id: 'line_1' },
      })
      expect(await scope.reserve(request(user, key, 'b'))).toEqual({ outcome: 'reused' })
    })
  })

  test('stores nothing when the transaction fails', async () => {
    const org = newOrganization()
    const user = newUser()
    const key = `key-${crypto.randomUUID()}`
    await expect(
      store.withOrganization(org, async (scope) => {
        await scope.reserve(request(user, key))
        throw new Error('the write failed')
      })
    ).rejects.toThrow('the write failed')
    expect(await count(org)).toBe(0)
    await store.withOrganization(org, async (scope) => {
      expect(await scope.reserve(request(user, key))).toEqual({ outcome: 'reserved' })
    })
  })

  test('tells a repeat that arrives while the key is held to try again', async () => {
    const org = newOrganization()
    const user = newUser()
    const key = `key-${crypto.randomUUID()}`
    let holding: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      holding = resolve
    })
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const first = store.withOrganization(org, async (scope) => {
      await scope.reserve(request(user, key))
      holding()
      await gate
      await scope.complete({ userId: user, route: 'lines.add', key }, 201, { id: 'line_1' })
    })
    await held
    const second = store.withOrganization(org, (scope) => scope.reserve(request(user, key)))
    await expect(second).rejects.toBeInstanceOf(IdempotencyInProgressError)
    finish()
    await first
    expect(await count(org)).toBe(1)
  })

  test('lets a waiting repeat see the answer when the first request commits within the wait', async () => {
    const org = newOrganization()
    const user = newUser()
    const key = `key-${crypto.randomUUID()}`
    let holding: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      holding = resolve
    })
    const first = store.withOrganization(org, async (scope) => {
      await scope.reserve(request(user, key))
      holding()
      await Bun.sleep(100)
      await scope.complete({ userId: user, route: 'lines.add', key }, 201, { id: 'line_1' })
    })
    await held
    const second = await store.withOrganization(org, (scope) => scope.reserve(request(user, key)))
    await first
    expect(second).toEqual({ outcome: 'replay', status: 201, response: { id: 'line_1' } })
  })

  test("never shows one Organization's key to another", async () => {
    const mine = newOrganization()
    const theirs = newOrganization()
    const user = newUser()
    const key = `key-${crypto.randomUUID()}`
    await store.withOrganization(mine, async (scope) => {
      await scope.reserve(request(user, key))
      await scope.complete({ userId: user, route: 'lines.add', key }, 201, { id: 'line_1' })
    })
    await store.withOrganization(theirs, async (scope) => {
      expect(await scope.reserve(request(user, key, 'b'))).toEqual({ outcome: 'reserved' })
      expect(await scope.remove({ userId: user, route: 'lines.add', key })).toBe(true)
      expect(await scope.purge(NOW, 100)).toBe(0)
    })
    // The first Organization's row survived the other one's remove and purge.
    expect(await count(mine)).toBe(1)
  })

  test('keeps keys apart per user and per route', async () => {
    const org = newOrganization()
    const key = `key-${crypto.randomUUID()}`
    const a = newUser()
    const b = newUser()
    await store.withOrganization(org, async (scope) => {
      expect(await scope.reserve(request(a, key))).toEqual({ outcome: 'reserved' })
      expect(await scope.reserve(request(b, key))).toEqual({ outcome: 'reserved' })
      expect(await scope.reserve({ ...request(a, key), route: 'lines.other' })).toEqual({
        outcome: 'reserved',
      })
    })
  })

  test('replaces a key that has expired', async () => {
    const org = newOrganization()
    const user = newUser()
    const key = `key-${crypto.randomUUID()}`
    await store.withOrganization(org, async (scope) => {
      await scope.reserve(request(user, key, 'a', new Date('2025-12-30T00:00:00.000Z')))
      await scope.complete({ userId: user, route: 'lines.add', key }, 201, { id: 'old' })
    })
    await store.withOrganization(org, async (scope) => {
      expect(await scope.reserve(request(user, key, 'b'))).toEqual({ outcome: 'reserved' })
    })
  })

  test('purges at most one batch of expired keys, oldest first, of its own Organization', async () => {
    const org = newOrganization()
    const other = newOrganization()
    const user = newUser()
    await store.withOrganization(org, async (scope) => {
      for (let i = 0; i < 5; i += 1) {
        const key = `old-${i}-${crypto.randomUUID()}`
        await scope.reserve(request(user, key, 'a', new Date(Date.UTC(2025, 11, 1, 0, 0, i))))
        await scope.complete({ userId: user, route: 'lines.add', key }, 201, {})
      }
      const fresh = `fresh-${crypto.randomUUID()}`
      await scope.reserve(request(user, fresh))
      await scope.complete({ userId: user, route: 'lines.add', key: fresh }, 201, {})
    })
    await store.withOrganization(other, async (scope) => {
      const key = `old-${crypto.randomUUID()}`
      await scope.reserve(request(user, key, 'a', new Date('2025-12-01T00:00:00.000Z')))
      await scope.complete({ userId: user, route: 'lines.add', key }, 201, {})
    })
    await store.withOrganization(org, async (scope) => {
      expect(await scope.purge(DAY_AGO, 3)).toBe(3)
    })
    expect(await count(org)).toBe(3)
    await store.withOrganization(org, async (scope) => {
      expect(await scope.purge(DAY_AGO, 3)).toBe(2)
    })
    expect(await count(org)).toBe(1)
    expect(await count(other)).toBe(1)
  })

  test('keeps the transaction usable after a purge that fails', async () => {
    const org = newOrganization()
    const user = newUser()
    await store.withOrganization(org, async (scope) => {
      await expect(scope.purge(DAY_AGO, 1.5)).rejects.toThrow()
      expect(await scope.reserve(request(user, `key-${crypto.randomUUID()}`))).toEqual({
        outcome: 'reserved',
      })
    })
  })

  test('refuses to rewrite a completed answer', async () => {
    const org = newOrganization()
    const user = newUser()
    const key = `key-${crypto.randomUUID()}`
    await store.withOrganization(org, async (scope) => {
      await scope.reserve(request(user, key))
      await scope.complete({ userId: user, route: 'lines.add', key }, 201, { id: 'line_1' })
    })
    await expect(
      store.withOrganization(org, (scope) =>
        scope.complete({ userId: user, route: 'lines.add', key }, 200, { id: 'other' })
      )
    ).rejects.toThrow()
  })

  test('commits a Line inserted within the scope together with its key, and rolls both back together', async () => {
    const org = newOrganization()
    const user = newUser()
    const newLine = () => ({
      id: formatId('line', crypto.randomUUID()),
      number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
      country: 'US',
      label: null,
      state: 'active' as const,
      providerSid: null,
      createdAt: NOW,
    })
    const kept = newLine()
    const key = `key-${crypto.randomUUID()}`
    await store.withOrganization(org, async (scope) => {
      await scope.reserve(request(user, key))
      await lines.insert(org, kept, scope)
      await scope.complete({ userId: user, route: 'lines.add', key }, 201, { id: kept.id })
    })
    expect((await lines.get(org, kept.id))?.id).toBe(kept.id)
    expect(await count(org)).toBe(1)

    const lost = newLine()
    await expect(
      store.withOrganization(org, async (scope) => {
        await scope.reserve(request(user, `key-${crypto.randomUUID()}`))
        await lines.insert(org, lost, scope)
        throw new Error('the request failed after the Line was written')
      })
    ).rejects.toThrow('the request failed')
    expect(await lines.get(org, lost.id)).toBeUndefined()
    expect(await count(org)).toBe(1)
  })
})
