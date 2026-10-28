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

test('concurrent claims on one Line never exceed the concurrent cap', async () => {
  const org = newOrganizationId()
  const line = await newLine(org)
  const at = new Date()
  const ids: string[] = []
  for (let n = 0; n < 8; n += 1) {
    const row = await store.insert(org, {
      id: formatId('acl', crypto.randomUUID()),
      idempotencyKey: `race-${crypto.randomUUID()}`,
      source: 'rep_request',
      prospectId: formatId('prs', crypto.randomUUID()),
      lineId: line,
      enrollmentId: null,
      stepKey: null,
      requestedByMembershipId: formatId('mem', crypto.randomUUID()),
      attempt: 1,
      state: 'queued',
      result: null,
      gateCode: null,
      retryAt: at,
      createdAt: new Date(at.getTime() - 1000),
    })
    ids.push(row.call.id)
  }
  const outcomes = await Promise.all(
    ids.map((id, n) =>
      store.claimDial(org, id, {
        at,
        numberHash: new Uint8Array(32).fill(n + 1),
        callId: formatId('call', crypto.randomUUID()),
        since: new Date(at.getTime() - 86_400_000),
        contactCheck: async () => undefined,
      })
    )
  )
  const claimed = outcomes.filter((o) => o.kind === 'claimed').length
  expect(claimed).toBe(3)
  expect(outcomes.filter((o) => o.kind === 'capped').length).toBe(5)
  expect((await store.lineUsage(org, line, new Date(0)))?.open).toBe(3)
})
