import { describe, expect, test } from 'bun:test'
import { AGENT_ERRORS, formatId, setAgentSettingsRequestSchema } from 'tula-closeline-contract'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  type TestApp,
  type TestIdentity,
} from '~/testing'
import * as Agent from './service'

const settings = {
  paused: false,
  greeting: 'Thanks for calling Acme.',
  voiceStyle: 'neutral',
  timeZone: 'America/New_York',
  hours: [{ day: 'mon', windows: [{ start: '09:00', end: '12:00' }] }],
  maxCallSeconds: 300,
  maxCostUsdCents: 100,
  concurrencyCap: 3,
}

const KEY = 'a-client-chosen-key-0001'

/** Puts the settings as `who`, with an Idempotency-Key. */
async function put(t: TestApp, who: TestIdentity, body: unknown, key: string) {
  const response = await t.app.request('/v1/agent/settings', {
    method: 'PUT',
    headers: {
      ...(await t.bearer(who)),
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as unknown }
}

describe('Agent settings', () => {
  test('a new Organization reads the defaults, and the Agent is paused', async () => {
    const t = await createTestApp()
    const res = await t.call(identityOf('admin'), 'GET', '/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ paused: true, languages: ['en'], updatedByMembershipId: null })
  })

  test.each([
    ['owner', 200],
    ['admin', 200],
    ['manager', 200],
    ['rep', 403],
  ] as const)('a %s reading the settings gets %i', async (role, status) => {
    const t = await createTestApp()
    const res = await t.call(identityOf(role), 'GET', '/agent/settings')
    expect(res.status).toBe(status)
    if (status === 403) {
      expect(res.body).toMatchObject({ error: { code: 'auth.forbidden' } })
    }
  })

  test.each([
    ['owner', 200],
    ['admin', 200],
    ['manager', 403],
    ['rep', 403],
  ] as const)('a %s writing the settings gets %i', async (role, status) => {
    const t = await createTestApp()
    const res = await t.call(identityOf(role), 'PUT', '/agent/settings', settings)
    expect(res.status).toBe(status)
  })

  test('a write replaces the settings and records who and when', async () => {
    const t = await createTestApp()
    const admin = identityOf('admin')
    const membershipId = formatId('mem', crypto.randomUUID())
    t.deps.directory.addMembership(admin.organizationId, admin.userId, membershipId)
    const put = await t.call(admin, 'PUT', '/agent/settings', settings)
    expect(put.body).toMatchObject({
      ...settings,
      languages: ['en'],
      updatedByMembershipId: membershipId,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const read = await t.call(identityOf('manager', admin.organizationId), 'GET', '/agent/settings')
    expect(read.body).toEqual(put.body)
    expect(await t.call(admin, 'PUT', '/agent/settings', settings)).toEqual(put)
  })

  test('another Organization never sees or changes these settings', async () => {
    const t = await createTestApp()
    const admin = identityOf('admin')
    await t.call(admin, 'PUT', '/agent/settings', settings)
    const other = await t.call(identityOf('admin'), 'GET', '/agent/settings')
    expect(other.body).toMatchObject({ paused: true })
    expect(other.body).not.toMatchObject({ greeting: settings.greeting })
  })

  test.each([
    ['a disclosure switch', { disclosure: false }],
    ['a recording switch', { recording: false }],
    ['a consent waiver', { requireConsent: false }],
  ])('%s is refused as request.invalid (ADR 0003)', async (_name, extra) => {
    const t = await createTestApp()
    const res = await t.call(identityOf('admin'), 'PUT', '/agent/settings', {
      ...settings,
      ...extra,
    })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: { code: 'request.invalid' } })
    expect(setAgentSettingsRequestSchema.safeParse({ ...settings, ...extra }).success).toBe(false)
  })

  test('hours outside the calling window are refused', async () => {
    const t = await createTestApp()
    const hours = [{ day: 'mon', windows: [{ start: '06:00', end: '12:00' }] }]
    const res = await t.call(identityOf('admin'), 'PUT', '/agent/settings', { ...settings, hours })
    expect([400, 422]).toContain(res.status)
  })

  test('a time zone the runtime does not know is agent.settings_invalid', async () => {
    const t = await createTestApp()
    const res = await t.call(identityOf('admin'), 'PUT', '/agent/settings', {
      ...settings,
      timeZone: 'Mars/Olympus',
    })
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: { code: 'agent.settings_invalid' } })
  })

  test('a repeated Idempotency-Key answers with the first settings and writes nothing again', async () => {
    const t = await createTestApp()
    const admin = identityOf('admin')
    const first = await put(t, admin, settings, KEY)
    t.deps.clock.advance('1h')
    const second = await put(t, admin, settings, KEY)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    const reused = await put(t, admin, { ...settings, paused: true }, KEY)
    expect(reused.status).toBe(422)
    expect(reused.body).toMatchObject({ error: { code: 'request.idempotency_key_reused' } })
  })
})

describe('the pause switch', () => {
  test('an Organization never set up is paused', async () => {
    const t = await createTestApp()
    expect(await Agent.isPaused(t.deps, newOrganizationId())).toBe(true)
  })

  test('pausing makes the check answer agent.paused, and resuming lets it through', async () => {
    const t = await createTestApp()
    const admin = identityOf('admin')
    await t.call(admin, 'PUT', '/agent/settings', { ...settings, paused: false })
    await Agent.assertNotPaused(t.deps, admin.organizationId)
    await t.call(admin, 'PUT', '/agent/settings', { ...settings, paused: true })
    await expect(Agent.assertNotPaused(t.deps, admin.organizationId)).rejects.toMatchObject({
      code: AGENT_ERRORS['agent.paused'].code,
      status: 409,
    })
  })

  test("one Organization's pause does not pause another", async () => {
    const t = await createTestApp()
    const a = identityOf('admin')
    const b = identityOf('admin')
    await t.call(a, 'PUT', '/agent/settings', { ...settings, paused: false })
    await t.call(b, 'PUT', '/agent/settings', { ...settings, paused: true })
    expect(await Agent.isPaused(t.deps, a.organizationId)).toBe(false)
    expect(await Agent.isPaused(t.deps, b.organizationId)).toBe(true)
  })
})
