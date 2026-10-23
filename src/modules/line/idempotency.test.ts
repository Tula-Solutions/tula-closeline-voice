import { beforeEach, describe, expect, it } from 'bun:test'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

type ErrorBody = { error: { code: string; details?: { retryAfter?: number } } }
type LineBody = { id: string; number: string }

let t: TestApp
let admin: TestIdentity

beforeEach(async () => {
  t = await createTestApp()
  admin = identityOf('admin')
})

const KEY = 'a-client-chosen-key-0001'
const buyBody = { method: 'buy', country: 'US', areaCode: '212' }

/** Posts to /lines with the given headers, as `who`. */
async function post(who: TestIdentity, body: unknown, headers: Record<string, string> = {}) {
  const response = await t.app.request('/v1/lines', {
    method: 'POST',
    headers: { ...(await t.bearer(who)), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : JSON.parse(text),
  }
}

/** Counts the numbers the provisioner is asked to buy or port. */
function countProvisioning(): { calls: () => number } {
  let calls = 0
  const { buy, port } = t.deps.numbers
  t.deps.numbers.buy = async (request) => {
    calls += 1
    return buy(request)
  }
  t.deps.numbers.port = async (number) => {
    calls += 1
    return port(number)
  }
  return { calls: () => calls }
}

const linesOf = async (who: TestIdentity) =>
  ((await t.call(who, 'GET', '/lines')).body as { items: LineBody[] }).items

describe('adding a Line with an Idempotency-Key', () => {
  it('answers a repeat with the stored Line and buys nothing again', async () => {
    const provisioning = countProvisioning()
    const first = await post(admin, buyBody, { 'idempotency-key': KEY })
    const again = await post(admin, buyBody, { 'idempotency-key': KEY })
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(provisioning.calls()).toBe(1)
    expect(await linesOf(admin)).toHaveLength(1)
  })

  it('treats the same body with its keys in another order as the same request', async () => {
    const provisioning = countProvisioning()
    await post(admin, buyBody, { 'idempotency-key': KEY })
    const again = await post(
      admin,
      { areaCode: '212', country: 'US', method: 'buy' },
      { 'idempotency-key': KEY }
    )
    expect(again.status).toBe(200)
    expect(provisioning.calls()).toBe(1)
  })

  it('refuses the same key with another body as request.idempotency_key_reused', async () => {
    const provisioning = countProvisioning()
    await post(admin, buyBody, { 'idempotency-key': KEY })
    const other = await post(admin, { ...buyBody, areaCode: '415' }, { 'idempotency-key': KEY })
    expect(other.status).toBe(422)
    expect((other.body as ErrorBody).error.code).toBe('request.idempotency_key_reused')
    expect(provisioning.calls()).toBe(1)
  })

  it('answers a key still in flight with request.idempotency_in_progress and Retry-After', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { buy } = t.deps.numbers
    let calls = 0
    t.deps.numbers.buy = async (request) => {
      calls += 1
      await gate
      return buy(request)
    }
    const first = post(admin, buyBody, { 'idempotency-key': KEY })
    await Bun.sleep(20)
    const second = await post(admin, buyBody, { 'idempotency-key': KEY })
    expect(second.status).toBe(409)
    expect((second.body as ErrorBody).error.code).toBe('request.idempotency_in_progress')
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect((second.body as ErrorBody).error.details?.retryAfter).toBeGreaterThanOrEqual(1)
    release()
    expect((await first).status).toBe(201)
    expect(calls).toBe(1)
    expect((await post(admin, buyBody, { 'idempotency-key': KEY })).status).toBe(200)
  })

  it('stores nothing for a failed request, so the key can be tried again', async () => {
    const { buy } = t.deps.numbers
    t.deps.numbers.buy = async () => {
      throw new Error('provider down')
    }
    const failed = await post(admin, buyBody, { 'idempotency-key': KEY })
    expect(failed.status).toBe(500)
    t.deps.numbers.buy = buy
    const retried = await post(admin, buyBody, { 'idempotency-key': KEY })
    expect(retried.status).toBe(201)
  })

  it('does not store the key of a refused request (a Rep is forbidden)', async () => {
    const rep = identityOf('rep', admin.organizationId)
    const refused = await post(rep, buyBody, { 'idempotency-key': KEY })
    expect(refused.status).toBe(403)
    expect(t.deps.idempotency.count(admin.organizationId)).toBe(0)
  })

  it('keeps keys apart per Organization: a second Organization cannot see or reuse one', async () => {
    const provisioning = countProvisioning()
    const other = identityOf('admin', newOrganizationId())
    const mine = await post(admin, buyBody, { 'idempotency-key': KEY })
    const theirs = await post(other, buyBody, { 'idempotency-key': KEY })
    expect(mine.status).toBe(201)
    expect(theirs.status).toBe(201)
    expect((theirs.body as LineBody).id).not.toBe((mine.body as LineBody).id)
    expect(provisioning.calls()).toBe(2)
    expect(await linesOf(other)).toHaveLength(1)
    // Even with a different body the other Organization's key is not "reused" here.
    const differing = await post(
      other,
      { ...buyBody, areaCode: '415' },
      { 'idempotency-key': 'z'.repeat(20) }
    )
    expect(differing.status).toBe(201)
    expect(t.deps.idempotency.count(admin.organizationId)).toBe(1)
    expect(t.deps.idempotency.count(other.organizationId)).toBe(2)
  })

  it('keeps keys apart per user inside one Organization', async () => {
    const provisioning = countProvisioning()
    const colleague = identityOf('owner', admin.organizationId)
    await post(admin, buyBody, { 'idempotency-key': KEY })
    const theirs = await post(colleague, buyBody, { 'idempotency-key': KEY })
    expect(theirs.status).toBe(201)
    expect(provisioning.calls()).toBe(2)
  })

  it('keeps keys apart per route name: a port is a different request from a buy', async () => {
    const port = { method: 'port', number: '+14155550100' }
    await post(admin, buyBody, { 'idempotency-key': KEY })
    const other = await post(admin, port, { 'idempotency-key': KEY })
    expect(other.status).toBe(422)
  })

  it('without a key every request buys a number', async () => {
    const provisioning = countProvisioning()
    await post(admin, buyBody)
    await post(admin, buyBody)
    expect(provisioning.calls()).toBe(2)
    expect(t.deps.idempotency.count(admin.organizationId)).toBe(0)
  })

  it('refuses a malformed key as request.invalid before anything is bought', async () => {
    const provisioning = countProvisioning()
    const bad = await post(admin, buyBody, { 'idempotency-key': 'short' })
    expect(bad.status).toBe(400)
    expect((bad.body as ErrorBody).error.code).toBe('request.invalid')
    expect(provisioning.calls()).toBe(0)
  })

  it('forgets a key after 24 hours: the same key is a new request', async () => {
    const provisioning = countProvisioning()
    await post(admin, buyBody, { 'idempotency-key': KEY })
    t.deps.clock.advance('25h')
    const later = await post(admin, buyBody, { 'idempotency-key': KEY })
    expect(later.status).toBe(201)
    expect(provisioning.calls()).toBe(2)
  })

  it('purges expired keys of its own Organization in one bounded batch', async () => {
    const other = identityOf('admin', newOrganizationId())
    await post(other, buyBody, { 'idempotency-key': KEY })
    for (let i = 0; i < 120; i += 1) {
      await post(admin, buyBody, {
        'idempotency-key': `old-key-${String(i).padStart(4, '0')}-xxxxxxxx`,
      })
    }
    expect(t.deps.idempotency.count(admin.organizationId)).toBe(120)
    t.deps.clock.advance('25h')
    await post(admin, buyBody, { 'idempotency-key': 'fresh-key-0000-xxxxxxxx' })
    // 100 of the 120 expired keys went; 20 expired remain, plus the new one.
    expect(t.deps.idempotency.count(admin.organizationId)).toBe(21)
    // Another Organization's expired key is not touched by this one's purge.
    expect(t.deps.idempotency.count(other.organizationId)).toBe(1)
  })
})
