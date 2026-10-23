import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { createPostgresIdempotencyStore } from '~/adapters/postgres/idempotency-store'
import { createPostgresLineStore } from '~/adapters/postgres/line-store'
import { integrationUrls } from '~/integration-support'
import { createTestApp, identityOf, newOrganizationId } from '~/testing'

const { db, close } = createDb(integrationUrls().service)
afterAll(close)

type LineBody = { id: string; number: string }

/** The real app over Postgres Lines and idempotency keys, with a memory number provisioner. */
async function postgresApp() {
  const t = await createTestApp()
  t.deps.lines = createPostgresLineStore(db)
  // The test double's `count` is unused here: the assertions go through the route.
  t.deps.idempotency = Object.assign(createPostgresIdempotencyStore(db, { waitMs: 300 }), {
    count: () => 0,
  })
  return t
}

const post = async (
  t: Awaited<ReturnType<typeof postgresApp>>,
  who: ReturnType<typeof identityOf>,
  body: unknown,
  key?: string
) => {
  const response = await t.app.request('/v1/lines', {
    method: 'POST',
    headers: {
      ...(await t.bearer(who)),
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('POST /v1/lines with an Idempotency-Key over Postgres', () => {
  test('a repeat answers 200 with the first Line and buys once; a second Organization is apart', async () => {
    const t = await postgresApp()
    let bought = 0
    const { buy } = t.deps.numbers
    t.deps.numbers.buy = async (request) => {
      bought += 1
      // The memory provisioner repeats numbers across runs, and a live number is unique in the database.
      return {
        ...(await buy(request)),
        number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
      }
    }
    const admin = identityOf('admin', newOrganizationId())
    const other = identityOf('admin', newOrganizationId())
    const key = `route-key-${crypto.randomUUID()}`
    const body = { method: 'buy', country: 'US', areaCode: '212' }

    const first = await post(t, admin, body, key)
    const again = await post(t, admin, body, key)
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(bought).toBe(1)

    const reused = await post(t, admin, { ...body, areaCode: '415' }, key)
    expect(reused.status).toBe(422)
    expect((reused.body as { error: { code: string } }).error.code).toBe(
      'request.idempotency_key_reused'
    )

    const theirs = await post(t, other, body, key)
    expect(theirs.status).toBe(201)
    expect((theirs.body as LineBody).id).not.toBe((first.body as LineBody).id)
    expect(bought).toBe(2)
  })
})
