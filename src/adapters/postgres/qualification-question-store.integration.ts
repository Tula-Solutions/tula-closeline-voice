import { afterAll, describe, expect, test } from 'bun:test'
import { formatId, type OrganizationId, type QualificationQuestion } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresQualificationQuestionStore } from './qualification-question-store'

const { db, close } = createDb(integrationUrls().service)
const store = createPostgresQualificationQuestionStore(db)

afterAll(close)

const newOrganization = (): OrganizationId => formatId('org', crypto.randomUUID())

const question = (position: number, prompt: string): QualificationQuestion => ({
  id: formatId('qst', crypto.randomUUID()),
  position,
  prompt,
  kind: 'free_text',
  choices: null,
  required: false,
  skipWhen: [],
})

/** Stores exactly these questions as the Organization's list. */
const seed = (org: OrganizationId, list: QualificationQuestion[]) =>
  store.change(org, () => ({ next: list, result: undefined }))

describe('the Postgres Qualification question store', () => {
  test('stores a list and reads it back in position order', async () => {
    const org = newOrganization()
    const [a, b, c] = [question(1, 'A'), question(2, 'B'), question(3, 'C')] as [
      QualificationQuestion,
      QualificationQuestion,
      QualificationQuestion,
    ]
    await seed(
      org,
      [c, a, b].map((q, i) => ({ ...q, position: i + 1 }))
    )
    const listed = await store.list(org, { limit: 10 })
    expect(listed.map((q) => q.prompt)).toEqual(['C', 'A', 'B'])
    expect(await store.get(org, a.id)).toEqual(listed[1])
  })

  test('change deletes dropped rows, updates changed ones and inserts new ones', async () => {
    const org = newOrganization()
    const a = question(1, 'A')
    const b = question(2, 'B')
    await seed(org, [a, b])
    const c = question(2, 'C')
    const result = await store.change(org, (current) => {
      expect(current.map((q) => q.prompt)).toEqual(['A', 'B'])
      return { next: [{ ...a, prompt: 'A2' }, c], result: 'done' }
    })
    expect(result).toBe('done')
    expect((await store.list(org, { limit: 10 })).map((q) => [q.prompt, q.position])).toEqual([
      ['A2', 1],
      ['C', 2],
    ])
    expect(await store.get(org, b.id)).toBeUndefined()
  })

  test('a change that throws leaves the list as it was', async () => {
    const org = newOrganization()
    await seed(org, [question(1, 'A')])
    await expect(
      store.change(org, () => {
        throw new Error('abandon')
      })
    ).rejects.toThrow('abandon')
    expect((await store.list(org, { limit: 10 })).map((q) => q.prompt)).toEqual(['A'])
  })

  test('concurrent changes run one after the other and lose no write', async () => {
    const org = newOrganization()
    const append = (prompt: string) =>
      store.change(org, (current) => ({
        next: [...current, question(current.length + 1, prompt)],
        result: undefined,
      }))
    await Promise.all(['A', 'B', 'C', 'D', 'E'].map(append))
    const listed = await store.list(org, { limit: 10 })
    expect(listed.map((q) => q.position)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(listed.map((q) => q.prompt)).size).toBe(5)
  })

  test('pages by (position, id) with no row skipped or repeated', async () => {
    const org = newOrganization()
    await seed(
      org,
      [1, 2, 3, 4, 5].map((n) => question(n, `Q${n}`))
    )
    const seen: string[] = []
    let cursor: { position: number; id: QualificationQuestion['id'] } | undefined
    for (let guard = 0; guard < 5; guard += 1) {
      const page = await store.list(org, { limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...page.map((q) => q.prompt))
      const last = page.at(-1)
      if (page.length < 2 || !last) {
        break
      }
      cursor = { position: last.position, id: last.id }
    }
    expect(seen).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
  })

  test("never shows or changes another Organization's questions", async () => {
    const a = newOrganization()
    const b = newOrganization()
    const mine = question(1, 'Mine')
    await seed(a, [mine])
    expect(await store.list(b, { limit: 10 })).toEqual([])
    expect(await store.get(b, mine.id)).toBeUndefined()
    await seed(b, [question(1, 'Theirs')])
    expect((await store.list(a, { limit: 10 })).map((q) => q.prompt)).toEqual(['Mine'])
    await store.change(b, () => ({ next: [], result: undefined }))
    expect(await store.get(a, mine.id)).toEqual(mine)
  })
})
