import { describe, expect, test } from 'bun:test'
import { COPILOT_ERRORS, formatId } from 'tula-closeline-contract'
import { createMemoryTelephony } from 'tula-closeline-kit/testing'
import { createTestApp, identityOf, newOrganizationId, type TestApp } from '~/testing'
import { forOrganization } from './service'

const good = { enabled: true, minMoments: 5, minDeals: 3 }

describe('Copilot settings', () => {
  test('a new Organization has the Copilot off with the default minimums', async () => {
    const t = await createTestApp()
    const res = await t.call(identityOf('rep'), 'GET', '/copilot/settings')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      enabled: false,
      minMoments: 3,
      minDeals: 2,
      updatedAt: null,
      updatedBy: null,
    })
  })

  test.each([
    ['owner', 200],
    ['admin', 200],
    ['manager', 403],
    ['rep', 403],
  ] as const)('a %s setting them gets %i', async (role, status) => {
    const t = await createTestApp()
    const res = await t.call(identityOf(role), 'PUT', '/copilot/settings', good)
    expect(res.status).toBe(status)
  })

  test('an Admin saves, reads back, and the row records who and when', async () => {
    const t = await createTestApp()
    const org = newOrganizationId()
    const admin = identityOf('admin', org)
    t.deps.directory.addMembership(org, admin.userId, formatId('mem', crypto.randomUUID()))
    const put = await t.call(admin, 'PUT', '/copilot/settings', good)
    expect(put.body).toMatchObject(good)
    const read = (await t.call(admin, 'GET', '/copilot/settings')).body
    expect(read).toEqual(put.body)
    expect((read as { updatedBy: string | null }).updatedBy).not.toBeNull()
    expect((read as { updatedAt: string | null }).updatedAt).not.toBeNull()
  })

  test.each([
    [{ enabled: true, minMoments: 0, minDeals: 1 }],
    [{ enabled: true, minMoments: 3, minDeals: 0 }],
    [{ enabled: true, minMoments: 21, minDeals: 1 }],
    [{ enabled: true, minMoments: 2, minDeals: 3 }],
  ])('%j is copilot.min_evidence_invalid and saves nothing', async (body) => {
    const t = await createTestApp()
    const org = newOrganizationId()
    const res = await t.call(identityOf('admin', org), 'PUT', '/copilot/settings', body)
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({
      error: { code: COPILOT_ERRORS['copilot.min_evidence_invalid'].code },
    })
    expect((await forOrganization(t.deps, org)).enabled).toBe(false)
  })

  test('one Organization never sees or changes another', async () => {
    const t = await createTestApp()
    const a = identityOf('admin', newOrganizationId())
    const b = identityOf('admin', newOrganizationId())
    await t.call(a, 'PUT', '/copilot/settings', good)
    expect((await t.call(b, 'GET', '/copilot/settings')).body).toMatchObject({ enabled: false })
    await t.call(b, 'PUT', '/copilot/settings', { ...good, enabled: false, minMoments: 9 })
    expect((await t.call(a, 'GET', '/copilot/settings')).body).toMatchObject(good)
  })
})

describe('dialing with the Copilot', () => {
  const PROSPECT = '+14155550123'

  async function setup(enabled: boolean) {
    const telephony = createMemoryTelephony()
    const t: TestApp = await createTestApp({ telephony })
    const org = newOrganizationId()
    const admin = identityOf('admin', org)
    const rep = identityOf('rep', org)
    const membership = formatId('mem', crypto.randomUUID())
    t.deps.directory.addMembership(org, rep.userId, membership)
    t.deps.directory.addRep(org, membership)
    const bought = await t.call(admin, 'POST', '/lines', { method: 'buy', country: 'US' })
    const lineId = (bought.body as { id: string }).id
    await t.call(admin, 'PUT', `/lines/${lineId}/assignment`, {
      kind: 'rep',
      membershipId: membership,
    })
    telephony.script(PROSPECT, { kind: 'answers' })
    if (enabled) {
      await t.call(admin, 'PUT', '/copilot/settings', good)
    }
    const res = await t.app.request('/v1/calls', {
      method: 'POST',
      headers: {
        ...(await t.bearer(rep)),
        'content-type': 'application/json',
        'idempotency-key': 'copilot-settings-key-0001',
      },
      body: JSON.stringify({ to: PROSPECT, copilot: true }),
    })
    const id = ((await res.json()) as { call: { id: string } }).call.id
    const stream = await t.app.request(`/v1/calls/${id}/copilot/stream`, {
      headers: await t.bearer(rep),
    })
    return { t, org, id, stream }
  }

  test('with the Copilot off the Call records it off and the stream is copilot.disabled', async () => {
    const { t, org, id, stream } = await setup(false)
    expect((await t.deps.calls.get(org, id as never))?.copilot).toBe(false)
    expect(stream.status).toBe(409)
    expect(await stream.json()).toMatchObject({ error: { code: 'copilot.disabled' } })
  })

  test('with the Copilot on the Call keeps the flag', async () => {
    const { t, org, id, stream } = await setup(true)
    expect((await t.deps.calls.get(org, id as never))?.copilot).toBe(true)
    expect(await stream.json()).toMatchObject({ error: { code: 'copilot.not_started' } })
  })
})
