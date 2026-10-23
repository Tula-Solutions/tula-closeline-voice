import { beforeEach, describe, expect, test } from 'bun:test'
import { formatId, softphoneTokenSchema } from 'tula-closeline-contract'
import { createTestApp, identityOf, type TestApp } from '~/testing'
import { createStubbedTwilio, TEST_BASE_URL } from '../webhook/twilio-fixture'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp({
    env: { WEBHOOK_BASE_URL: TEST_BASE_URL },
    telephony: createStubbedTwilio(),
  })
})

const membership = () => formatId('mem', crypto.randomUUID().replaceAll('-', ''))

/** The claims of a JWT, read without verifying: the test looks at what the token says. */
function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
}

describe('POST /v1/softphone/token', () => {
  test('a Rep gets a short-lived token for their own Membership', async () => {
    const rep = identityOf('rep')
    const mine = membership()
    t.deps.directory.addMembership(rep.organizationId, rep.userId, mine)

    const { status, body } = await t.call(rep, 'POST', '/softphone/token')

    expect(status).toBe(200)
    const token = softphoneTokenSchema.parse(body)
    expect(token.identity).toBe(mine)
    expect(token.ttlSeconds).toBeLessThanOrEqual(900)
    // The adapter reads the real clock; the app's test clock is fixed.
    const lifetimeMs = new Date(token.expiresAt).getTime() - Date.now()
    expect(Math.abs(lifetimeMs - token.ttlSeconds * 1000)).toBeLessThan(5000)
  })

  test('the token carries the Rep and the Organization and nothing else of theirs', async () => {
    const rep = identityOf('rep')
    t.deps.directory.addMembership(rep.organizationId, rep.userId, membership())

    const { body } = await t.call(rep, 'POST', '/softphone/token')
    const claims = claimsOf(softphoneTokenSchema.parse(body).token)
    const text = JSON.stringify(claims)

    expect(text).toContain(rep.organizationId)
    expect(text).not.toContain(rep.userId)
    expect(text).not.toContain('rep"')
  })

  test.each(['owner', 'admin', 'manager', 'rep'] as const)(
    '%s may ask for a token',
    async (role) => {
      const who = identityOf(role)
      t.deps.directory.addMembership(who.organizationId, who.userId, membership())
      expect((await t.call(who, 'POST', '/softphone/token')).status).toBe(200)
    }
  )

  test('someone with no Membership in the Organization is refused', async () => {
    const stranger = identityOf('rep')
    const { status, body } = await t.call(stranger, 'POST', '/softphone/token')
    expect(status).toBe(403)
    expect((body as { error: { code: string } }).error.code).toBe('auth.forbidden')
  })

  test('a Membership of another Organization is not used', async () => {
    const rep = identityOf('rep')
    t.deps.directory.addMembership(identityOf('rep').organizationId, rep.userId, membership())
    expect((await t.call(rep, 'POST', '/softphone/token')).status).toBe(403)
  })

  test('without an access token the answer is 401', async () => {
    const response = await t.app.request('/v1/softphone/token', { method: 'POST' })
    expect(response.status).toBe(401)
  })

  test('the token is not cached and never logged', async () => {
    const rep = identityOf('rep')
    t.deps.directory.addMembership(rep.organizationId, rep.userId, membership())
    const response = await t.app.request('/v1/softphone/token', {
      method: 'POST',
      headers: await t.bearer(rep),
    })
    const { token } = softphoneTokenSchema.parse(await response.json())
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(t.deps.logLines.join('\n')).not.toContain(token)
  })

  test('a provider that does not answer is server.unavailable', async () => {
    const rep = identityOf('rep')
    t.deps.directory.addMembership(rep.organizationId, rep.userId, membership())
    t.deps.telephony.mintBrowserToken = async () => {
      throw new Error('boom')
    }
    expect((await t.call(rep, 'POST', '/softphone/token')).status).toBe(503)
  })
})
