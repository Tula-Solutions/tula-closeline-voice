import { beforeEach, describe, expect, test } from 'bun:test'
import {
  formatId,
  type Handoff,
  handoffContextSchema,
  handoffPageSchema,
  handoffSchema,
} from 'tula-closeline-contract'
import { createTestApp, identityOf, type TestApp, type TestIdentity } from '~/testing'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp()
})

/** A pending offer of a new Call to a new Rep of the given Organization. */
async function offered(rep = identityOf('rep'), at = '2026-01-01T00:00:00Z') {
  const membershipId = formatId('mem', crypto.randomUUID()) as NonNullable<
    Handoff['repMembershipId']
  >
  t.deps.directory.addMembership(rep.organizationId, rep.userId, membershipId)
  return offerTo(rep, membershipId, at)
}

/** A pending offer of a new Call (with a stored row) to the Membership. */
async function offerTo(
  rep: TestIdentity,
  membershipId: NonNullable<Handoff['repMembershipId']>,
  at = '2026-01-01T00:00:00Z'
) {
  const callId = formatId('call', crypto.randomUUID())
  await t.deps.calls.insertInbound(rep.organizationId, {
    id: callId,
    lineId: formatId('line', crypto.randomUUID()) as never,
    repMembershipId: null,
    callerNumber: '+14155550100',
    providerCallSid: 'CA-test',
    createdAt: new Date(at),
  })
  const handoff = await t.deps.handoffs.offer(rep.organizationId, {
    callId,
    repMembershipId: membershipId,
    attempt: 1,
    reason: 'asked_for_rep',
    at: new Date(at),
  })
  return { rep, handoff: handoff as Handoff }
}

describe('POST /v1/handoffs/{id}/accept and /decline', () => {
  test('the offered Rep accepts, and a repeat returns the same Handoff', async () => {
    const { rep, handoff } = await offered()
    const first = await t.call(rep, 'POST', `/handoffs/${handoff.id}/accept`)
    const again = await t.call(rep, 'POST', `/handoffs/${handoff.id}/accept`)
    expect(first.status).toBe(200)
    expect(handoffSchema.parse(first.body).state).toBe('accepted')
    expect(again).toEqual(first)
  })

  test('declining ends the offer; accepting after is handoff.not_pending (409)', async () => {
    const { rep, handoff } = await offered()
    const declined = await t.call(rep, 'POST', `/handoffs/${handoff.id}/decline`)
    expect(declined.status).toBe(200)
    const late = await t.call(rep, 'POST', `/handoffs/${handoff.id}/accept`)
    expect(late.status).toBe(409)
    expect(late.body).toMatchObject({ error: { code: 'handoff.not_pending' } })
  })

  test("another Organization's Rep gets handoff.not_found (404)", async () => {
    const { handoff } = await offered()
    const stranger = identityOf('rep')
    t.deps.directory.addMembership(
      stranger.organizationId,
      stranger.userId,
      formatId('mem', crypto.randomUUID())
    )
    const { status, body } = await t.call(stranger, 'POST', `/handoffs/${handoff.id}/accept`)
    expect(status).toBe(404)
    expect(body).toMatchObject({ error: { code: 'handoff.not_found' } })
  })

  test('a malformed id is 400 and no token is 401', async () => {
    const { rep } = await offered()
    expect((await t.call(rep, 'POST', '/handoffs/nope/accept')).status).toBe(400)
    const anonymous = await t.app.request('/v1/handoffs/hof_x/accept', { method: 'POST' })
    expect(anonymous.status).toBe(401)
  })
})

describe('GET /v1/handoffs', () => {
  test('a Rep lists only what is offered to them, in their own Organization', async () => {
    const { rep, handoff } = await offered()
    await offered(identityOf('rep', rep.organizationId))
    await offered()
    const { status, body } = await t.call(rep, 'GET', '/handoffs?state=pending&limit=5')
    expect(status).toBe(200)
    expect(handoffPageSchema.parse(body).items.map((h) => h.id)).toEqual([handoff.id])
  })

  test('pages newest first with a cursor, and a bad cursor is 400', async () => {
    const { rep } = await offered(undefined, '2026-01-01T00:00:00Z')
    const membership = (await t.deps.directory.membershipOf(
      rep.organizationId,
      rep.userId
    )) as never
    const newer = await offerTo(rep, membership, '2026-01-02T00:00:00Z')
    const first = handoffPageSchema.parse((await t.call(rep, 'GET', '/handoffs?limit=1')).body)
    expect(first.items.map((h) => h.id)).toEqual([newer.handoff.id])
    const next = handoffPageSchema.parse(
      (await t.call(rep, 'GET', `/handoffs?limit=1&cursor=${first.nextCursor}`)).body
    )
    expect(next.items).toHaveLength(1)
    expect(next.nextCursor).toBeNull()
    expect((await t.call(rep, 'GET', '/handoffs?cursor=nope')).status).toBe(400)
    expect((await t.call(rep, 'GET', '/handoffs?limit=101')).status).toBe(400)
  })

  test('a Manager sees their Team Reps, an Admin sees all, a Rep not the other Rep', async () => {
    const { rep, handoff } = await offered()
    const other = identityOf('rep', rep.organizationId)
    const otherMembership = formatId('mem', crypto.randomUUID()) as never
    t.deps.directory.addMembership(other.organizationId, other.userId, otherMembership)
    const seen = (who: Parameters<typeof t.call>[0]) =>
      t.call(who, 'GET', '/handoffs').then((r) => handoffPageSchema.parse(r.body).items.length)
    expect(await seen(other)).toBe(0)
    const manager = identityOf('manager', rep.organizationId)
    const managerMembership = formatId('mem', crypto.randomUUID()) as never
    t.deps.directory.addMembership(manager.organizationId, manager.userId, managerMembership)
    expect(await seen(manager)).toBe(0)
    t.deps.directory.addTeamReps(manager.organizationId, managerMembership, [
      handoff.repMembershipId as string,
    ])
    expect(await seen(manager)).toBe(1)
    expect(await seen(identityOf('admin', rep.organizationId))).toBe(1)
  })

  test('no token is 401', async () => {
    expect((await t.app.request('/v1/handoffs')).status).toBe(401)
  })
})

describe('GET /v1/handoffs/{id}', () => {
  test('the offered Rep reads the Prospect, the Qualification and the last turns', async () => {
    const { rep, handoff } = await offered()
    const callId = handoff.callId as string
    const org = rep.organizationId
    await t.deps.turns.append(
      org,
      { kind: 'call', id: callId },
      {
        index: 0,
        role: 'prospect',
        text: 'Ten seats?',
        deferred: false,
        toolName: null,
        sources: [],
      }
    )
    const inquiry = crypto.randomUUID()
    const question = formatId('qst', crypto.randomUUID())
    t.deps.qualification.linkCall(org, callId, inquiry, formatId('prs', crypto.randomUUID()))
    await t.deps.qualification.record(org, inquiry, {
      questionId: question,
      value: 10,
      skipped: false,
    })
    await t.deps.qualification.setSummary(org, inquiry, 'Wants ten seats.')
    const { status, body } = await t.call(rep, 'GET', `/handoffs/${handoff.id}`)
    expect(status).toBe(200)
    const context = handoffContextSchema.parse(body)
    expect(context.qualification).toEqual({
      answers: [{ questionId: question, value: 10, skipped: false }],
      summary: 'Wants ten seats.',
    })
    expect(context.recentTurns.map((turn) => turn.text)).toEqual(['Ten seats?'])
  })

  test('a Handoff whose Call has no Prospect yet is handoff.not_found', async () => {
    const { rep, handoff } = await offered()
    const { status } = await t.call(rep, 'GET', `/handoffs/${handoff.id}`)
    expect(status).toBe(404)
  })

  test('an Inquiry with no answers gives an empty Qualification', async () => {
    const { rep, handoff } = await offered()
    t.deps.qualification.linkCall(
      rep.organizationId,
      handoff.callId as string,
      crypto.randomUUID(),
      formatId('prs', crypto.randomUUID())
    )
    const { body } = await t.call(rep, 'GET', `/handoffs/${handoff.id}`)
    expect(handoffContextSchema.parse(body).qualification).toEqual({ answers: [], summary: null })
  })

  test("another Rep, and another Organization's Rep, get handoff.not_found (404)", async () => {
    const { rep, handoff } = await offered()
    const sameOrg = identityOf('rep', rep.organizationId)
    t.deps.directory.addMembership(
      sameOrg.organizationId,
      sameOrg.userId,
      formatId('mem', crypto.randomUUID())
    )
    const stranger = identityOf('rep')
    t.deps.directory.addMembership(
      stranger.organizationId,
      stranger.userId,
      formatId('mem', crypto.randomUUID())
    )
    for (const who of [sameOrg, stranger]) {
      const { status, body } = await t.call(who, 'GET', `/handoffs/${handoff.id}`)
      expect(status).toBe(404)
      expect(body).toMatchObject({ error: { code: 'handoff.not_found' } })
    }
  })

  test('a malformed id is 400', async () => {
    const { rep } = await offered()
    expect((await t.call(rep, 'GET', '/handoffs/nope')).status).toBe(400)
  })
})
