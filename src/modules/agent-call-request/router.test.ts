import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { LOCAL_INTERNAL_API_TOKEN } from '~/env'
import { identityOf, type TestApp, type TestIdentity } from '~/testing'
import { type Answer, addLine, addProspect, askInternal, setup, stepBody, unpause } from './support'

/** Posts to the Rep route as `who`; `key` null leaves the Idempotency-Key out. */
async function askAsRep(t: TestApp, who: TestIdentity, body: unknown, key: string | null) {
  const response = await t.app.request('/v1/agent-calls', {
    method: 'POST',
    headers: {
      ...(await t.bearer(who)),
      'content-type': 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify({ goal: 'Book a demo.', ...(body as object) }),
  })
  return { status: response.status, body: (await response.json()) as Answer }
}

/** An Organization with a Rep who holds a Membership, and a Prospect the Rep sees. */
async function repSetup() {
  const ctx = await setup()
  const rep = identityOf('rep', ctx.org)
  ctx.t.deps.directory.addMembership(ctx.org, rep.userId, formatId('mem', crypto.randomUUID()))
  const seen = addProspect(ctx.t, ctx.org, { visibleTo: [rep.userId] })
  return { ...ctx, rep, seen }
}

describe('POST /internal/v1/agent-calls', () => {
  test.each([
    ['no secret', {}],
    ['a wrong secret', { authorization: 'Bearer not-the-secret-not-the-secret-0123456789' }],
  ])('%s is 401', async (_name, headers) => {
    const { t, org, line, prospect } = await setup()
    const res = await t.app.request('/internal/v1/agent-calls', {
      method: 'POST',
      headers: { ...headers, 'x-organization-id': org, 'content-type': 'application/json' },
      body: JSON.stringify(stepBody(prospect, line)),
    })
    expect(res.status).toBe(401)
  })

  test('a missing Organization header or an invalid body is 400', async () => {
    const { t, org, line, prospect } = await setup()
    const noOrg = await t.app.request('/internal/v1/agent-calls', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LOCAL_INTERNAL_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(stepBody(prospect, line)),
    })
    expect(noOrg.status).toBe(400)
    expect((await askInternal(t, org, { prospectId: prospect })).status).toBe(400)
  })

  test('an unknown Prospect is 404 prospect.not_found', async () => {
    const { t, org, line } = await setup()
    const res = await askInternal(t, org, stepBody(formatId('prs', crypto.randomUUID()), line))
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('prospect.not_found')
  })

  test('a key that is not enrollment:step:attempt is 400', async () => {
    const { t, org, line, prospect } = await setup()
    const res = await askInternal(
      t,
      org,
      stepBody(prospect, line, { idempotencyKey: 'some-other-key-0000001' })
    )
    expect(res.status).toBe(400)
  })

  test('without a Line given, the first active Line is used', async () => {
    const { t, org, line, prospect } = await setup()
    const res = await askInternal(t, org, stepBody(prospect, null))
    expect(res.body.lineId).toBe(line)
  })
})

describe('POST /v1/agent-calls', () => {
  test('no token is 401, and a missing Idempotency-Key is 400', async () => {
    const { t, rep, seen } = await repSetup()
    const anon = await t.app.request('/v1/agent-calls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prospectId: seen, lineId: null }),
    })
    expect(anon.status).toBe(401)
    const noKey = await askAsRep(t, rep, { prospectId: seen, lineId: null }, null)
    expect(noKey.status).toBe(400)
  })

  test('a Rep requests a Call to a Prospect they see: 201, then 200 for the same key', async () => {
    const { t, rep, seen } = await repSetup()
    const key = 'rep-key-0000000000000001'
    const first = await askAsRep(t, rep, { prospectId: seen, lineId: null }, key)
    const second = await askAsRep(t, rep, { prospectId: seen, lineId: null }, key)
    expect([first.status, second.status]).toEqual([201, 200])
    expect(first.body).toMatchObject({ source: 'rep_request', state: 'queued' })
    expect(second.body.id).toBe(first.body.id)
  })

  test('a Prospect the Rep cannot see is 404 prospect.not_found, an Admin sees them', async () => {
    const { t, org, rep } = await repSetup()
    const hidden = addProspect(t, org)
    const res = await askAsRep(
      t,
      rep,
      { prospectId: hidden, lineId: null },
      'rep-key-0000000000000002'
    )
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('prospect.not_found')
    const admin = identityOf('admin', org)
    t.deps.directory.addMembership(org, admin.userId, formatId('mem', crypto.randomUUID()))
    const ok = await askAsRep(
      t,
      admin,
      { prospectId: hidden, lineId: null },
      'rep-key-0000000000000003'
    )
    expect(ok.status).toBe(201)
  })

  test("the Rep's request does not waive the Contact Check", async () => {
    const { t, org, rep } = await repSetup()
    const noConsent = addProspect(t, org, { visibleTo: [rep.userId], allow: false })
    const res = await askAsRep(
      t,
      rep,
      { prospectId: noConsent, lineId: null },
      'rep-key-0000000000000004'
    )
    expect(res.body).toMatchObject({ result: 'blocked', gateCode: 'consent.missing' })
  })

  test('a caller with no Membership is 403 auth.forbidden', async () => {
    const { t, org, seen } = await repSetup()
    const stranger = identityOf('rep', org)
    const res = await askAsRep(
      t,
      stranger,
      { prospectId: seen, lineId: null },
      'rep-key-0000000000000005'
    )
    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('auth.forbidden')
  })

  test('another Organization sees the Prospect as not found', async () => {
    const { t, seen } = await repSetup()
    const other = identityOf('owner')
    await unpause(t, other.organizationId)
    await addLine(t, other.organizationId)
    t.deps.directory.addMembership(
      other.organizationId,
      other.userId,
      formatId('mem', crypto.randomUUID())
    )
    const res = await askAsRep(
      t,
      other,
      { prospectId: seen, lineId: null },
      'rep-key-0000000000000006'
    )
    expect(res.status).toBe(404)
  })
})

describe('Idempotency-Key replays', () => {
  test("another Rep cannot replay a key to read the first Rep's Agent Call", async () => {
    const { t, org, rep, seen } = await repSetup()
    const key = 'rep-key-0000000000000010'
    expect((await askAsRep(t, rep, { prospectId: seen, lineId: null }, key)).status).toBe(201)
    const other = identityOf('rep', org)
    t.deps.directory.addMembership(org, other.userId, formatId('mem', crypto.randomUUID()))
    const res = await askAsRep(t, other, { prospectId: seen, lineId: null }, key)
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('prospect.not_found')
    expect(res.body.id).toBeUndefined()
  })

  test('the same key with another Prospect is request.idempotency_key_reused', async () => {
    const { t, org, rep, seen } = await repSetup()
    const key = 'rep-key-0000000000000011'
    await askAsRep(t, rep, { prospectId: seen, lineId: null }, key)
    const second = addProspect(t, org, { visibleTo: [rep.userId] })
    const res = await askAsRep(t, rep, { prospectId: second, lineId: null }, key)
    expect(res.status).toBe(422)
    expect(res.body.error?.code).toBe('request.idempotency_key_reused')
  })

  test('a Rep key shaped like a Step key is 400, so it cannot pre-empt a Campaign Step', async () => {
    const { t, rep, seen } = await repSetup()
    const key = `${formatId('enr', crypto.randomUUID())}:first_call:1`
    const res = await askAsRep(t, rep, { prospectId: seen, lineId: null }, key)
    expect(res.status).toBe(400)
  })
})
