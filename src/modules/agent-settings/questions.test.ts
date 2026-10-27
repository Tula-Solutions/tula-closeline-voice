import { beforeEach, describe, expect, test } from 'bun:test'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

type Question = {
  id: string
  position: number
  prompt: string
  kind: string
  choices: string[] | null
  required: boolean
  skipWhen: { questionId: string; operator: string; value?: unknown }[]
}
type Page = { items: Question[]; nextCursor: string | null }
type ErrorBody = { error: { code: string } }

let t: TestApp
let admin: TestIdentity

beforeEach(async () => {
  t = await createTestApp()
  admin = identityOf('admin', newOrganizationId())
})

const codeOf = (body: unknown): string => (body as ErrorBody).error.code
const add = (prompt: string, extra: Record<string, unknown> = {}, who = admin) =>
  t.call(who, 'POST', '/agent/questions', { prompt, kind: 'free_text', ...extra })
const idOf = (res: { body: unknown }): string => (res.body as Question).id
const order = async (who = admin) =>
  ((await t.call(who, 'GET', '/agent/questions')).body as Page).items.map((q) => q.prompt)

describe('creating questions', () => {
  test('adds last with position 1..n and defaults', async () => {
    const a = await add('Budget?')
    const b = await add('Timeline?')
    expect(a.status).toBe(201)
    expect(a.body).toMatchObject({ position: 1, required: false, skipWhen: [], choices: null })
    expect(b.body).toMatchObject({ position: 2 })
  })

  test('a position puts it there and moves the rest down', async () => {
    await add('A')
    await add('B')
    const c = await add('C', { position: 1 })
    expect(c.body).toMatchObject({ position: 1 })
    expect(await order()).toEqual(['C', 'A', 'B'])
    const items = ((await t.call(admin, 'GET', '/agent/questions')).body as Page).items
    expect(items.map((q) => q.position)).toEqual([1, 2, 3])
  })

  test('a position beyond the end is agent.question_invalid', async () => {
    const res = await add('A', { position: 3 })
    expect(res.status).toBe(422)
    expect(codeOf(res.body)).toBe('agent.question_invalid')
  })

  test('the 51st question is agent.question_invalid', async () => {
    for (let i = 0; i < 50; i += 1) {
      expect((await add(`Q${i}`)).status).toBe(201)
    }
    const res = await add('one too many')
    expect(res.status).toBe(422)
    expect(codeOf(res.body)).toBe('agent.question_invalid')
    expect((await t.call(admin, 'GET', '/agent/questions?limit=100')).body).toMatchObject({
      items: expect.any(Array),
    })
  })

  test('a choice question needs choices, and others must not have them', async () => {
    expect((await add('Pick', { kind: 'choice' })).status).toBe(400)
    expect((await add('Pick', { kind: 'free_text', choices: ['a', 'b'] })).status).toBe(400)
    expect((await add('Pick', { kind: 'choice', choices: ['a', 'b'] })).status).toBe(201)
  })

  test('skip logic may look at an earlier question', async () => {
    const a = idOf(await add('Do you own?', { kind: 'yes_no' }))
    const b = await add('Which home?', {
      skipWhen: [{ questionId: a, operator: 'equals', value: false }],
    })
    expect(b.status).toBe(201)
  })

  test.each([
    ['an unknown question', () => ({ questionId: `qst_${'0'.repeat(32)}` })],
    ['a later question (a loop)', () => ({ questionId: 'LATER' })],
  ])('skip logic on %s is agent.question_invalid', async (_name, condition) => {
    await add('A')
    const later = idOf(await add('B'))
    const cond = { operator: 'answered', ...condition() }
    if (cond.questionId === 'LATER') {
      cond.questionId = later
    }
    // Insert at the front so the question it looks at comes after it.
    const res = await add('C', { position: 1, skipWhen: [cond] })
    expect(res.status).toBe(422)
    expect(codeOf(res.body)).toBe('agent.question_invalid')
  })

  test('a repeated Idempotency-Key answers 200 with the first question and adds nothing', async () => {
    const send = async () => {
      const response = await t.app.request('/v1/agent/questions', {
        method: 'POST',
        headers: {
          ...(await t.bearer(admin)),
          'content-type': 'application/json',
          'idempotency-key': 'question-key-0000001',
        },
        body: JSON.stringify({ prompt: 'Budget?', kind: 'free_text' }),
      })
      return { status: response.status, body: (await response.json()) as Question }
    }
    const first = await send()
    const second = await send()
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(await order()).toEqual(['Budget?'])
  })
})

describe('reading questions', () => {
  test('lists in order, one cursor page at a time', async () => {
    for (const p of ['A', 'B', 'C']) {
      await add(p)
    }
    const first = (await t.call(admin, 'GET', '/agent/questions?limit=2')).body as Page
    expect(first.items.map((q) => q.prompt)).toEqual(['A', 'B'])
    expect(first.nextCursor).not.toBeNull()
    const second = (
      await t.call(admin, 'GET', `/agent/questions?limit=2&cursor=${first.nextCursor}`)
    ).body as Page
    expect(second.items.map((q) => q.prompt)).toEqual(['C'])
    expect(second.nextCursor).toBeNull()
  })

  test('a malformed cursor is request.invalid', async () => {
    const res = await t.call(admin, 'GET', '/agent/questions?cursor=not-a-cursor')
    expect(res.status).toBe(400)
    expect(codeOf(res.body)).toBe('request.invalid')
  })

  test('a manager reads, a rep does not', async () => {
    const id = idOf(await add('A'))
    const manager = identityOf('manager', admin.organizationId)
    const rep = identityOf('rep', admin.organizationId)
    expect((await t.call(manager, 'GET', '/agent/questions')).status).toBe(200)
    expect((await t.call(manager, 'GET', `/agent/questions/${id}`)).status).toBe(200)
    expect((await t.call(rep, 'GET', '/agent/questions')).status).toBe(403)
    expect((await t.call(rep, 'GET', `/agent/questions/${id}`)).status).toBe(403)
  })

  test('an unknown question is agent.question_not_found', async () => {
    const res = await t.call(admin, 'GET', `/agent/questions/qst_${'1'.repeat(32)}`)
    expect(res.status).toBe(404)
    expect(codeOf(res.body)).toBe('agent.question_not_found')
  })
})

describe('writing questions is for Owner and Admin', () => {
  test.each(['manager', 'rep'] as const)(
    'a %s cannot create, change, delete or reorder',
    async (role) => {
      const id = idOf(await add('A'))
      const who = identityOf(role, admin.organizationId)
      const body = { prompt: 'X', kind: 'free_text', choices: null, required: false, skipWhen: [] }
      const results = [
        await add('B', {}, who),
        await t.call(who, 'PATCH', `/agent/questions/${id}`, body),
        await t.call(who, 'DELETE', `/agent/questions/${id}`),
        await t.call(who, 'PUT', '/agent/question-order', { questionIds: [id] }),
      ]
      for (const res of results) {
        expect(res.status).toBe(403)
        expect(codeOf(res.body)).toBe('auth.forbidden')
      }
      expect(await order()).toEqual(['A'])
    }
  )
})

describe('changing and removing questions', () => {
  const content = (extra: Record<string, unknown> = {}) => ({
    prompt: 'New',
    kind: 'number',
    choices: null,
    required: true,
    skipWhen: [],
    ...extra,
  })

  test('update replaces the content and keeps the position', async () => {
    await add('A')
    const b = idOf(await add('B'))
    const res = await t.call(admin, 'PATCH', `/agent/questions/${b}`, content())
    expect(res.body).toMatchObject({
      id: b,
      position: 2,
      prompt: 'New',
      kind: 'number',
      required: true,
    })
  })

  test('update cannot make a question look at a later one', async () => {
    const a = idOf(await add('A'))
    const b = idOf(await add('B'))
    const res = await t.call(
      admin,
      'PATCH',
      `/agent/questions/${a}`,
      content({ skipWhen: [{ questionId: b, operator: 'answered' }] })
    )
    expect(res.status).toBe(422)
    expect(codeOf(res.body)).toBe('agent.question_invalid')
  })

  test('update of an unknown question is agent.question_not_found', async () => {
    const res = await t.call(admin, 'PATCH', `/agent/questions/qst_${'2'.repeat(32)}`, content())
    expect(res.status).toBe(404)
    expect(codeOf(res.body)).toBe('agent.question_not_found')
  })

  test('delete answers 204, closes the gap, and a second delete is not found', async () => {
    const a = idOf(await add('A'))
    await add('B')
    expect((await t.call(admin, 'DELETE', `/agent/questions/${a}`)).status).toBe(204)
    const items = ((await t.call(admin, 'GET', '/agent/questions')).body as Page).items
    expect(items.map((q) => [q.prompt, q.position])).toEqual([['B', 1]])
    const again = await t.call(admin, 'DELETE', `/agent/questions/${a}`)
    expect(again.status).toBe(404)
    expect(codeOf(again.body)).toBe('agent.question_not_found')
  })

  test('delete is refused while a later question skips on it', async () => {
    const a = idOf(await add('A'))
    await add('B', { skipWhen: [{ questionId: a, operator: 'answered' }] })
    const res = await t.call(admin, 'DELETE', `/agent/questions/${a}`)
    expect(res.status).toBe(422)
    expect(codeOf(res.body)).toBe('agent.question_invalid')
    expect(await order()).toEqual(['A', 'B'])
  })
})

describe('reordering questions', () => {
  test('sets the order and answers with every question', async () => {
    const a = idOf(await add('A'))
    const b = idOf(await add('B'))
    const c = idOf(await add('C'))
    const res = await t.call(admin, 'PUT', '/agent/question-order', { questionIds: [c, a, b] })
    expect(res.status).toBe(200)
    expect((res.body as Page).items.map((q) => [q.prompt, q.position])).toEqual([
      ['C', 1],
      ['A', 2],
      ['B', 3],
    ])
    expect(await order()).toEqual(['C', 'A', 'B'])
  })

  test('an unknown id is agent.question_not_found', async () => {
    const a = idOf(await add('A'))
    const res = await t.call(admin, 'PUT', '/agent/question-order', {
      questionIds: [a, `qst_${'3'.repeat(32)}`],
    })
    expect(res.status).toBe(404)
    expect(codeOf(res.body)).toBe('agent.question_not_found')
  })

  test('leaving a question out is agent.question_invalid', async () => {
    const a = idOf(await add('A'))
    await add('B')
    const res = await t.call(admin, 'PUT', '/agent/question-order', { questionIds: [a] })
    expect(res.status).toBe(422)
    expect(codeOf(res.body)).toBe('agent.question_invalid')
  })

  test('an order that puts a question before one it skips on is agent.question_invalid', async () => {
    const a = idOf(await add('A'))
    const b = idOf(await add('B', { skipWhen: [{ questionId: a, operator: 'answered' }] }))
    const res = await t.call(admin, 'PUT', '/agent/question-order', { questionIds: [b, a] })
    expect(res.status).toBe(422)
    expect(codeOf(res.body)).toBe('agent.question_invalid')
    expect(await order()).toEqual(['A', 'B'])
  })
})

describe('Organization isolation', () => {
  test("another Organization cannot read, change, delete or reorder this one's questions", async () => {
    const id = idOf(await add('Secret'))
    const other = identityOf('admin', newOrganizationId())
    expect(await order(other)).toEqual([])
    const body = { prompt: 'X', kind: 'free_text', choices: null, required: false, skipWhen: [] }
    expect((await t.call(other, 'GET', `/agent/questions/${id}`)).status).toBe(404)
    expect((await t.call(other, 'PATCH', `/agent/questions/${id}`, body)).status).toBe(404)
    expect((await t.call(other, 'DELETE', `/agent/questions/${id}`)).status).toBe(404)
    expect(
      (await t.call(other, 'PUT', '/agent/question-order', { questionIds: [id] })).status
    ).toBe(404)
    expect(await order()).toEqual(['Secret'])
    await add('Theirs', {}, other)
    expect(await order()).toEqual(['Secret'])
  })
})
