import { expect, test } from 'bun:test'
import { createMemoryTwilioPurgeSource } from '~/adapters/memory/twilio-purge-source'
import { createTestDeps } from '~/testing'
import { startTwilioPurgeSchedule } from './start'

test('no schedule starts without a Postgres-backed purge source', () => {
  expect(startTwilioPurgeSchedule(createTestDeps())).toBeUndefined()
})

test('a schedule starts when the container has a purge source, and stops cleanly', async () => {
  const deps = { ...createTestDeps(), twilioPurge: createMemoryTwilioPurgeSource() }
  const schedule = startTwilioPurgeSchedule(deps)
  expect(schedule).toBeDefined()
  await schedule?.stop()
})
