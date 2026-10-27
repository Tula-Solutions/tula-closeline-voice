import { afterAll, describe, expect, test } from 'bun:test'
import { type AgentSettings, formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import { createPostgresAgentSettingsStore } from './agent-settings-store'

const { db, close } = createDb(integrationUrls().service)
const store = createPostgresAgentSettingsStore(db)

afterAll(close)

const newOrganization = (): OrganizationId => formatId('org', crypto.randomUUID())

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  ...DEFAULT_AGENT_SETTINGS,
  hours: [...DEFAULT_AGENT_SETTINGS.hours],
  paused: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('the Postgres Agent settings store', () => {
  test('has nothing for an Organization that never saved', async () => {
    expect(await store.get(newOrganization())).toBeUndefined()
  })

  test('creates the row on the first put and reads it back', async () => {
    const org = newOrganization()
    const written = await store.put(org, settings({ greeting: 'Hello there' }))
    expect(written.greeting).toBe('Hello there')
    expect(await store.get(org)).toEqual(written)
  })

  test('a second put replaces the whole row', async () => {
    const org = newOrganization()
    await store.put(org, settings({ greeting: 'One', concurrencyCap: 9 }))
    const second = await store.put(org, settings({ greeting: 'Two', concurrencyCap: 2 }))
    expect(await store.get(org)).toEqual(second)
    expect(second).toMatchObject({ greeting: 'Two', concurrencyCap: 2 })
  })

  test("never shows or changes another Organization's row", async () => {
    const a = newOrganization()
    const b = newOrganization()
    await store.put(a, settings({ greeting: 'A greeting' }))
    expect(await store.get(b)).toBeUndefined()
    await store.put(b, settings({ greeting: 'B greeting' }))
    expect((await store.get(a))?.greeting).toBe('A greeting')
    expect((await store.get(b))?.greeting).toBe('B greeting')
  })
})
