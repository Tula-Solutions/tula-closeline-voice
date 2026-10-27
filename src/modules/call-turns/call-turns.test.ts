import { beforeEach, describe, expect, test } from 'bun:test'
import { type CallId, formatId, type OrganizationId } from 'tula-closeline-contract'
import { LOCAL_INTERNAL_API_TOKEN } from '~/env'
import { createTestApp, newOrganizationId, type TestApp } from '~/testing'
import { callTurnsResponseSchema, MAX_TURN_WINDOW } from './schema'

let t: TestApp
const SECRET_TEXT = 'my card number is 4111 1111 1111 1111'

beforeEach(async () => {
  t = await createTestApp()
})

/** Stores a Call of `org` with `count` turns (even indexes Prospect, odd Agent). */
async function seedCall(org: OrganizationId, count: number): Promise<CallId> {
  const id = formatId('call', crypto.randomUUID())
  await t.deps.calls.insert(org, {
    id,
    lineId: formatId('line', crypto.randomUUID()),
    repMembershipId: formatId('mem', crypto.randomUUID()),
    prospectId: null,
    prospectNumber: '+14155550100',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
  for (let index = 0; index < count; index++) {
    await t.deps.turns.append(
      org,
      { kind: 'call', id },
      {
        index,
        role: index % 2 === 0 ? 'prospect' : 'agent',
        text: index === 3 ? SECRET_TEXT : `turn ${index}`,
        deferred: false,
        toolName: null,
        sources: [],
      }
    )
  }
  return id
}

function get(
  callId: string,
  query: string,
  options: { org?: string | null; secret?: string | null } = {}
) {
  const org = options.org
  const secret = options.secret === undefined ? LOCAL_INTERNAL_API_TOKEN : options.secret
  return t.app.request(`/internal/v1/calls/${callId}/turns?${query}`, {
    headers: {
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
      ...(org === null || org === undefined ? {} : { 'x-organization-id': org }),
    },
  })
}

const indexesOf = async (response: Response) =>
  callTurnsResponseSchema.parse(await response.json()).turns.map((turn) => turn.index)

describe('GET /internal/v1/calls/{callId}/turns', () => {
  test('returns the turns around the asked-for one, oldest first', async () => {
    const org = newOrganizationId()
    const call = await seedCall(org, 10)
    const response = await get(call, 'around=5&window=2', { org })
    expect(response.status).toBe(200)
    expect(await indexesOf(response)).toEqual([3, 4, 5, 6, 7])
  })

  test('is clipped at the first and last turn of the Call', async () => {
    const org = newOrganizationId()
    const call = await seedCall(org, 6)
    expect(await indexesOf(await get(call, 'around=0&window=2', { org }))).toEqual([0, 1, 2])
    expect(await indexesOf(await get(call, 'around=5&window=2', { org }))).toEqual([3, 4, 5])
  })

  test('window 0 is the turn alone and the default window is 5', async () => {
    const org = newOrganizationId()
    const call = await seedCall(org, 30)
    expect(await indexesOf(await get(call, 'around=10&window=0', { org }))).toEqual([10])
    expect(await indexesOf(await get(call, 'around=15', { org }))).toHaveLength(11)
  })

  test('the largest window is bounded', async () => {
    const org = newOrganizationId()
    const call = await seedCall(org, 60)
    const turns = await indexesOf(await get(call, `around=30&window=${MAX_TURN_WINDOW}`, { org }))
    expect(turns).toHaveLength(2 * MAX_TURN_WINDOW + 1)
    expect((await get(call, `around=30&window=${MAX_TURN_WINDOW + 1}`, { org })).status).toBe(400)
  })

  test('a second Organization finds no such Call', async () => {
    const owner = newOrganizationId()
    const call = await seedCall(owner, 6)
    const response = await get(call, 'around=2', { org: newOrganizationId() })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'request.not_found'
    )
  })

  test('a missing Call and a missing turn are not found', async () => {
    const org = newOrganizationId()
    const call = await seedCall(org, 4)
    expect((await get(formatId('call', crypto.randomUUID()), 'around=1', { org })).status).toBe(404)
    expect((await get(call, 'around=9', { org })).status).toBe(404)
  })

  test('a missing or wrong secret is refused before anything is read', async () => {
    const org = newOrganizationId()
    const call = await seedCall(org, 4)
    for (const secret of [null, 'not-the-secret-not-the-secret-not-the-secret']) {
      const response = await get(call, 'around=1', { org, secret })
      expect(response.status).toBe(401)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'auth.unauthenticated'
      )
    }
  })

  test.each([
    ['no around', 'window=2'],
    ['a negative around', 'around=-1'],
    ['a fractional around', 'around=1.5'],
    ['a non-numeric window', 'around=1&window=x'],
    ['a negative window', 'around=1&window=-1'],
  ])('%s is a 400', async (_name, query) => {
    const org = newOrganizationId()
    const call = await seedCall(org, 4)
    expect((await get(call, query, { org })).status).toBe(400)
  })

  test('a missing Organization header or a malformed Call id is a 400', async () => {
    const org = newOrganizationId()
    const call = await seedCall(org, 4)
    expect((await get(call, 'around=1')).status).toBe(400)
    expect((await get('not-a-call', 'around=1', { org })).status).toBe(400)
  })

  test('the turn text is never logged', async () => {
    const org = newOrganizationId()
    const call = await seedCall(org, 6)
    const response = await get(call, 'around=3&window=1', { org })
    expect(await response.text()).toContain(SECRET_TEXT)
    await get(call, 'around=3', { org, secret: 'wrong-wrong-wrong-wrong-wrong-wrong' })
    await get(call, 'around=99', { org })
    expect(t.deps.logLines.join('\n')).not.toContain('4111')
  })
})
