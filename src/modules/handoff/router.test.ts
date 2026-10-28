import { beforeEach, describe, expect, test } from 'bun:test'
import { formatId, type Handoff, handoffSchema } from 'tula-closeline-contract'
import { createTestApp, identityOf, type TestApp } from '~/testing'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp()
})

/** A pending offer of a new Call to a new Rep of the given Organization. */
async function offered(rep = identityOf('rep')) {
  const membershipId = formatId('mem', crypto.randomUUID()) as NonNullable<
    Handoff['repMembershipId']
  >
  t.deps.directory.addMembership(rep.organizationId, rep.userId, membershipId)
  const callId = formatId('call', crypto.randomUUID())
  const handoff = await t.deps.handoffs.offer(rep.organizationId, {
    callId,
    repMembershipId: membershipId,
    attempt: 1,
    reason: 'asked_for_rep',
    at: new Date('2026-01-01T00:00:00Z'),
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
