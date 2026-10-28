import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { voiceAgentCalls } from 'tula-closeline-db/schema'
import { integrationUrls } from '~/integration-support'
import { createPostgresAgentCallStore } from './agent-call-store'
import { agentCallStoreBehaviour, newOrganizationId } from './agent-call-store.behaviour'
import { createPostgresLineStore } from './line-store'

const { db, close } = createDb(integrationUrls().service)
const lines = createPostgresLineStore(db)
const store = createPostgresAgentCallStore(db)

afterAll(close)

async function newLine(org: OrganizationId) {
  const line = await lines.insert(org, {
    id: formatId('line', crypto.randomUUID()),
    number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  return line.id
}

agentCallStoreBehaviour('postgres', () => ({
  store,
  newLine,
  // The dialer (a later ticket) makes this change; the gate only reads it.
  dial: async (org, id, dial) => {
    const ended = dial.open === false
    await withOrganization(db, org, (tx) =>
      tx
        .update(voiceAgentCalls)
        .set({
          lineId: dial.lineId,
          numberHash: Buffer.from(dial.hash),
          dialedAt: dial.at,
          retryAt: null,
          state: ended ? 'ended' : 'dialing',
          result: ended ? (dial.answered ? 'answered' : 'no_answer') : null,
          endReason: ended && dial.answered ? 'agent_ended' : null,
          endedAt: ended ? dial.at : null,
        })
        .where(eq(voiceAgentCalls.id, id))
    )
  },
}))

test('a Line of another Organization or one that does not exist has no usage', async () => {
  const a = newOrganizationId()
  const b = newOrganizationId()
  const line = await newLine(a)
  const since = new Date(0)
  expect(await store.lineUsage(a, line, since)).toMatchObject({ open: 0, dials: 0 })
  expect(await store.lineUsage(b, line, since)).toBeUndefined()
  expect(await store.lineUsage(a, formatId('line', crypto.randomUUID()), since)).toBeUndefined()
})
