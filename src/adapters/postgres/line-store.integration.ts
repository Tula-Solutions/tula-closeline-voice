import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { type LineCursor, type NewLine, NumberTakenError } from '~/ports/line-store'
import { createPostgresLineStore } from './line-store'

const { db, close } = createDb(integrationUrls().service)
const store = createPostgresLineStore(db)

afterAll(close)

const newOrganization = (): OrganizationId => formatId('org', crypto.randomUUID())

/** A number no earlier run used, since the live-number key is global across Organizations. */
const randomNumber = (): string =>
  `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

function newLine(createdAt: Date, number = randomNumber()): NewLine {
  return {
    id: formatId('line', crypto.randomUUID()),
    number,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt,
  }
}

describe('the Postgres Line store', () => {
  test('inserts a Line unassigned and reads it back', async () => {
    const org = newOrganization()
    const input = newLine(new Date('2026-01-01T00:00:00.000Z'))
    const inserted = await store.insert(org, input)
    expect(inserted.assignment).toEqual({ kind: 'unassigned' })
    expect(inserted.releasedAt).toBeNull()
    expect(await store.get(org, input.id)).toEqual(inserted)
  })

  test('maps a live number held by any Organization to NumberTakenError', async () => {
    const number = randomNumber()
    await store.insert(newOrganization(), newLine(new Date(), number))
    await expect(
      store.insert(newOrganization(), newLine(new Date(), number))
    ).rejects.toBeInstanceOf(NumberTakenError)
  })

  test('lets a released number be taken again', async () => {
    const org = newOrganization()
    const number = randomNumber()
    const line = await store.insert(org, newLine(new Date(), number))
    await store.release(org, line.id, new Date())
    const again = await store.insert(newOrganization(), newLine(new Date(), number))
    expect(again.number).toBe(number)
  })

  test('pages newest first by keyset, with no row skipped or repeated', async () => {
    const org = newOrganization()
    const ids: string[] = []
    // Two Lines share a timestamp, so the id must break the tie.
    for (const second of [1, 2, 2, 3, 4]) {
      const line = await store.insert(org, newLine(new Date(Date.UTC(2026, 0, 1, 0, 0, second))))
      ids.push(line.id)
    }
    const seen: string[] = []
    let cursor: LineCursor | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const rows = await store.list(org, { limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...rows.map((row) => row.id))
      const last = rows.at(-1)
      if (rows.length < 2 || !last) {
        break
      }
      cursor = { createdAt: last.createdAt, id: last.id }
    }
    expect([...seen].sort()).toEqual([...ids].sort())
    expect(new Set(seen).size).toBe(5)
    expect(seen).toHaveLength(5)
  })

  test('filters by state', async () => {
    const org = newOrganization()
    const line = await store.insert(org, newLine(new Date()))
    await store.insert(org, { ...newLine(new Date()), state: 'porting' })
    await store.release(org, line.id, new Date())
    const released = await store.list(org, { limit: 10, state: 'released' })
    expect(released.map((row) => row.id)).toEqual([line.id])
  })

  test('assigns, clears on release, and refuses to assign a released Line', async () => {
    const org = newOrganization()
    const line = await store.insert(org, newLine(new Date()))
    const teamId = formatId('team', crypto.randomUUID())
    const assigned = await store.assign(org, line.id, { kind: 'team', teamId })
    expect(assigned?.assignment).toEqual({ kind: 'team', teamId })

    const at = new Date('2026-02-01T00:00:00.000Z')
    const released = await store.release(org, line.id, at)
    expect(released?.state).toBe('released')
    expect(released?.assignment).toEqual({ kind: 'unassigned' })
    expect(released?.releasedAt).toBe(at.toISOString())

    expect(await store.assign(org, line.id, { kind: 'team', teamId })).toBeUndefined()
    // Releasing again returns the Line as it was, with the first release time.
    expect((await store.release(org, line.id, new Date()))?.releasedAt).toBe(at.toISOString())
  })

  test('stores a role assignment and finds the oldest Line assigned to it', async () => {
    const org = newOrganization()
    const older = await store.insert(org, newLine(new Date('2026-01-01T00:00:00.000Z')))
    const newer = await store.insert(org, newLine(new Date('2026-01-02T00:00:00.000Z')))
    for (const line of [newer, older]) {
      const assigned = await store.assign(org, line.id, { kind: 'role', role: 'admin' })
      expect(assigned?.assignment).toEqual({ kind: 'role', role: 'admin' })
    }
    const [first] = await store.list(org, {
      limit: 1,
      assignedTo: { kind: 'role', role: 'admin' },
      oldestFirst: true,
    })
    expect(first?.id).toBe(older.id)
    expect(
      await store.list(org, { limit: 5, assignedTo: { kind: 'role', role: 'owner' } })
    ).toEqual([])
    const back = await store.assign(org, older.id, { kind: 'unassigned' })
    expect(back?.assignment).toEqual({ kind: 'unassigned' })
  })

  test('another Organization cannot read, list, assign or release a Line', async () => {
    const owner = newOrganization()
    const outsider = newOrganization()
    const line = await store.insert(owner, newLine(new Date()))

    expect(await store.get(outsider, line.id)).toBeUndefined()
    expect(await store.list(outsider, { limit: 10 })).toEqual([])
    expect(await store.assign(outsider, line.id, { kind: 'unassigned' })).toBeUndefined()
    expect(await store.release(outsider, line.id, new Date())).toBeUndefined()
    expect((await store.get(owner, line.id))?.state).toBe('active')
  })

  test('forgets the provider id only of a released Line', async () => {
    const org = newOrganization()
    const line = await store.insert(org, newLine(new Date()))
    await store.clearProviderSid(org, line.id)
    expect((await store.get(org, line.id))?.providerSid).not.toBeNull()
    await store.release(org, line.id, new Date())
    await store.clearProviderSid(org, line.id)
    expect((await store.get(org, line.id))?.providerSid).toBeNull()
  })

  test('finds the active Line behind a number, with its Organization', async () => {
    const org = newOrganization()
    // The lookup answers only for an active Organization, which core owns; seed one as the owner.
    const owner = createDb(integrationUrls().owner)
    await withOrganization(owner.db, org, async (tx) => {
      await tx.execute(
        sql`insert into core.organizations (organization_id, name, region) values (${org}, 'Test', 'us')`
      )
      await tx.execute(
        sql`insert into core.memberships (id, organization_id, user_id, role, email)
            values (${formatId('mem', crypto.randomUUID())}, ${org}, ${formatId('usr', crypto.randomUUID())}, 'owner', 'owner@example.test')`
      )
    })
    await owner.close()
    const input = newLine(new Date())
    await store.insert(org, input)
    const found = await store.byNumber(input.number)
    expect(found?.organizationId).toBe(org)
    expect(found?.line.id).toBe(input.id)
    expect(await store.byNumber(randomNumber())).toBeUndefined()
  })
})
