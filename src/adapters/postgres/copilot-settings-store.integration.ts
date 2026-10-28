import { afterAll, describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresCopilotSettingsStore } from './copilot-settings-store'

const { db, close } = createDb(integrationUrls().service)
const store = createPostgresCopilotSettingsStore(db)

afterAll(close)

const settings = (enabled: boolean, minMoments: number) => ({
  enabled,
  minMoments,
  minDeals: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
})

describe('the Postgres Copilot settings store', () => {
  test('has nothing until saved, then replaces the row and keeps Organizations apart', async () => {
    const a = formatId('org', crypto.randomUUID())
    const b = formatId('org', crypto.randomUUID())
    expect(await store.get(a)).toBeUndefined()
    await store.put(a, settings(true, 4))
    const second = await store.put(a, settings(false, 6))
    expect(await store.get(a)).toEqual(second)
    expect(second).toMatchObject({ enabled: false, minMoments: 6 })
    expect(await store.get(b)).toBeUndefined()
  })
})
