import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { voiceInquiries } from 'tula-closeline-db/schema'
import { integrationUrls } from '~/integration-support'
import { createPostgresCallStore } from './call-store'
import { createPostgresLineStore } from './line-store'
import { createPostgresQualificationStore } from './qualification-store'

const { db, close } = createDb(integrationUrls().service)
const store = createPostgresQualificationStore(db)
const calls = createPostgresCallStore(db)
const lines = createPostgresLineStore(db)

afterAll(close)

const newOrganization = (): OrganizationId => formatId('org', crypto.randomUUID())

/** Inserts a Call and an Inquiry made from it; returns both ids. */
async function seed(org: OrganizationId) {
  const now = new Date()
  const line = await lines.insert(org, {
    id: formatId('line', crypto.randomUUID()),
    number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: now,
  })
  const callId = formatId('call', crypto.randomUUID())
  await calls.insert(org, {
    id: callId,
    lineId: line.id,
    repMembershipId: formatId('mem', crypto.randomUUID()),
    prospectId: null,
    prospectNumber: '+14155550100',
    createdAt: now,
  })
  const inquiryId = formatId('inq', crypto.randomUUID())
  await withOrganization(db, org, (tx) =>
    tx.insert(voiceInquiries).values({
      id: inquiryId,
      organizationId: org,
      idempotencyKey: `test-${crypto.randomUUID()}`,
      source: 'call',
      prospectId: formatId('prs', crypto.randomUUID()),
      callId,
      callbackState: 'not_applicable',
    })
  )
  return { callId, inquiryId }
}

describe('the Postgres Qualification store', () => {
  test("details give the Prospect and the summary, and only to the Inquiry's Organization", async () => {
    const org = newOrganization()
    const { inquiryId } = await seed(org)
    expect((await store.details(org, inquiryId))?.summary).toBeNull()
    await store.setSummary(org, inquiryId, 'Wants ten seats.')
    const details = await store.details(org, inquiryId)
    expect(details?.summary).toBe('Wants ten seats.')
    expect(details?.prospectId.startsWith('prs_')).toBe(true)
    expect(await store.details(newOrganization(), inquiryId)).toBeUndefined()
  })

  test('finds the Inquiry of a Call and records answers, replacing one to the same question', async () => {
    const org = newOrganization()
    const { callId, inquiryId } = await seed(org)
    expect(await store.inquiryOfCall(org, callId)).toBe(inquiryId)
    const q1 = formatId('qst', crypto.randomUUID())
    const q2 = formatId('qst', crypto.randomUUID())
    const q3 = formatId('qst', crypto.randomUUID())
    await store.record(org, inquiryId, { questionId: q1, value: 'ten', skipped: false })
    await store.record(org, inquiryId, { questionId: q2, value: true, skipped: false })
    await store.record(org, inquiryId, { questionId: q3, value: null, skipped: true })
    await store.record(org, inquiryId, { questionId: q1, value: 12, skipped: false })
    const answers = await store.answers(org, inquiryId)
    expect(answers).toHaveLength(3)
    expect(answers.find((a) => a.questionId === q1)).toEqual({
      questionId: q1,
      value: 12,
      skipped: false,
    })
    expect(answers.find((a) => a.questionId === q2)?.value).toBe(true)
    expect(answers.find((a) => a.questionId === q3)).toEqual({
      questionId: q3,
      value: null,
      skipped: true,
    })
  })

  test('stores the summary on the Inquiry', async () => {
    const org = newOrganization()
    const { inquiryId } = await seed(org)
    await store.setSummary(org, inquiryId, 'Ten seats, wants a demo')
    const [row] = await withOrganization(db, org, (tx) =>
      tx.select().from(voiceInquiries).where(eq(voiceInquiries.id, inquiryId))
    )
    expect(row?.qualificationSummary).toBe('Ten seats, wants a demo')
  })

  test('another Organization sees no Inquiry and no answers', async () => {
    const orgA = newOrganization()
    const orgB = newOrganization()
    const { callId, inquiryId } = await seed(orgA)
    const question = formatId('qst', crypto.randomUUID())
    await store.record(orgA, inquiryId, { questionId: question, value: 'x', skipped: false })
    expect(await store.inquiryOfCall(orgB, callId)).toBeUndefined()
    expect(await store.answers(orgB, inquiryId)).toEqual([])
  })
})
