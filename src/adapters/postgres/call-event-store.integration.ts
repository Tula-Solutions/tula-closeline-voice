import { afterAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { voiceCallEvents, voiceCalls } from 'tula-closeline-db/schema'
import { integrationUrls } from '~/integration-support'
import { createPostgresCallEventStore } from './call-event-store'
import { createPostgresLineStore } from './line-store'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
const store = createPostgresCallEventStore(service.db)
const lines = createPostgresLineStore(service.db)

afterAll(async () => {
  await service.close()
  await owner.close()
})

const hex = () => crypto.randomUUID().replaceAll('-', '')
const newOrganization = (): OrganizationId => formatId('org', crypto.randomUUID())

/** A Call row, made as the owner because the Call module that writes them is a later ticket. */
async function insertCall(organizationId: OrganizationId): Promise<string> {
  const line = await lines.insert(organizationId, {
    id: formatId('line', crypto.randomUUID()),
    number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${hex()}`,
    createdAt: new Date(),
  })
  const id = formatId('call', hex())
  await withOrganization(owner.db, organizationId, (tx) =>
    tx.insert(voiceCalls).values({
      id,
      organizationId,
      direction: 'outbound',
      state: 'ringing',
      lineId: line.id,
      prospectNumber: '+15551230000',
    })
  )
  return id
}

const callback = (organizationId: OrganizationId, callId: string, providerEventId: string) => ({
  organizationId,
  callId,
  providerEventId,
  occurredAt: new Date('2026-01-01T00:00:05.000Z'),
})

const rowsOf = (organizationId: OrganizationId, callId: string) =>
  withOrganization(service.db, organizationId, (tx) =>
    tx
      .select()
      .from(voiceCallEvents)
      .where(
        and(eq(voiceCallEvents.organizationId, organizationId), eq(voiceCallEvents.callId, callId))
      )
  )

describe('the Postgres call event store', () => {
  test('records a provider callback once and answers duplicate for the same event id', async () => {
    const org = newOrganization()
    const callId = await insertCall(org)

    expect(await store.recordProviderCallback(callback(org, callId, 'evt-1'))).toBe('recorded')
    expect(await store.recordProviderCallback(callback(org, callId, 'evt-1'))).toBe('duplicate')

    const rows = await rowsOf(org, callId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'provider_callback', providerEventId: 'evt-1' })
  })

  test('different event ids of one call are both recorded', async () => {
    const org = newOrganization()
    const callId = await insertCall(org)
    await store.recordProviderCallback(callback(org, callId, 'evt-1'))
    await store.recordProviderCallback(callback(org, callId, 'evt-2'))
    expect(await rowsOf(org, callId)).toHaveLength(2)
  })

  test('a call that does not exist is unknown_call and nothing is written', async () => {
    const org = newOrganization()
    const callId = formatId('call', hex())
    expect(await store.recordProviderCallback(callback(org, callId, 'evt-1'))).toBe('unknown_call')
    expect(await rowsOf(org, callId)).toHaveLength(0)
  })

  test('another Organization cannot record against a call that is not its own', async () => {
    const org = newOrganization()
    const callId = await insertCall(org)
    const other = newOrganization()
    expect(await store.recordProviderCallback(callback(other, callId, 'evt-1'))).toBe(
      'unknown_call'
    )
    expect(await rowsOf(org, callId)).toHaveLength(0)
  })

  test('concurrent deliveries of one event record it once', async () => {
    const org = newOrganization()
    const callId = await insertCall(org)
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.recordProviderCallback(callback(org, callId, 'evt-race'))
      )
    )
    expect(results.filter((r) => r === 'recorded')).toHaveLength(1)
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(7)
  })
})
