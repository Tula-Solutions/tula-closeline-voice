import { beforeEach, describe, expect, it } from 'bun:test'
import { type CallId, type DealRecordId, formatId } from 'tula-closeline-contract'
import { createTestApp, identityOf, newOrganizationId, type TestApp } from '~/testing'

let t: TestApp
let org: ReturnType<typeof newOrganizationId>
let callId: CallId
let rep: ReturnType<typeof identityOf>
let repMembership: string

const asRep = (who: ReturnType<typeof identityOf>) => who

async function seedCall(organizationId: typeof org, membership: string | null) {
  const id = formatId('call', crypto.randomUUID()) as CallId
  await t.deps.calls.insertInbound(organizationId, {
    id,
    lineId: formatId('line', crypto.randomUUID()),
    repMembershipId: membership,
    callerNumber: '+14155550100',
    providerCallSid: `CA${crypto.randomUUID()}`,
    createdAt: new Date(),
  } as never)
  return id
}

async function seedCard(organizationId: typeof org, on: CallId, shownAt = new Date()) {
  const moment = formatId('call', crypto.randomUUID()) as CallId
  const dealRecordId = formatId('deal', crypto.randomUUID()) as DealRecordId
  return t.deps.copilotCards.append(organizationId, on, {
    evidence: { moments: 3, deals: 2 },
    citedMoments: [{ callId: moment, dealRecordId }],
    quotes: [{ callId: moment, dealRecordId, prospect: 'Too expensive.', repNext: 'Here is why.' }],
    shownAt,
  })
}

const get = async (who: ReturnType<typeof identityOf>, path: string) =>
  t.call(asRep(who), 'GET', path)

beforeEach(async () => {
  t = await createTestApp()
  org = newOrganizationId()
  rep = identityOf('rep', org)
  repMembership = formatId('mem', crypto.randomUUID())
  t.deps.directory.addMembership(org, rep.userId, repMembership)
  callId = await seedCall(org, repMembership)
})

describe('GET /v1/calls/{callId}/copilot/cards', () => {
  it('lists the cards oldest first, a page at a time, with a cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await seedCard(org, callId)
    }
    const first = await get(rep, `/calls/${callId}/copilot/cards?limit=2`)
    expect(first.status).toBe(200)
    const body = first.body as { items: { sequence: number }[]; nextCursor: string | null }
    expect(body.items.map((c) => c.sequence)).toEqual([1, 2])
    expect(body.nextCursor).not.toBeNull()
    const next = await get(rep, `/calls/${callId}/copilot/cards?limit=2&cursor=${body.nextCursor}`)
    expect(
      (next.body as { items: { sequence: number }[]; nextCursor: null }).items.map(
        (c) => c.sequence
      )
    ).toEqual([3])
    expect((next.body as { nextCursor: null }).nextCursor).toBeNull()
  })

  it('filters by kind and answers an empty page for a Call without cards', async () => {
    await seedCard(org, callId)
    const none = await get(rep, `/calls/${callId}/copilot/cards?kind=objection`)
    expect((none.body as { items: unknown[] }).items).toEqual([])
    const empty = await get(rep, `/calls/${await seedCall(org, repMembership)}/copilot/cards`)
    expect(empty.status).toBe(200)
  })

  it('shows a Manager their Team, an Admin all, and hides it from another Rep', async () => {
    await seedCard(org, callId)
    const path = `/calls/${callId}/copilot/cards`
    const other = identityOf('rep', org)
    t.deps.directory.addMembership(org, other.userId, formatId('mem', crypto.randomUUID()))
    expect((await get(other, path)).status).toBe(404)
    const manager = identityOf('manager', org)
    const managerMembership = formatId('mem', crypto.randomUUID())
    t.deps.directory.addMembership(org, manager.userId, managerMembership)
    expect((await get(manager, path)).status).toBe(404)
    t.deps.directory.addTeamReps(org, managerMembership, [repMembership])
    expect((await get(manager, path)).status).toBe(200)
    expect((await get(identityOf('admin', org), path)).status).toBe(200)
  })

  it('is call.not_found for another Organization, and 401 without a token', async () => {
    await seedCard(org, callId)
    const path = `/calls/${callId}/copilot/cards`
    const stranger = identityOf('owner', newOrganizationId())
    const response = await get(stranger, path)
    expect(response.status).toBe(404)
    expect((response.body as { error: { code: string } }).error.code).toBe('call.not_found')
    expect((await t.app.request(`/v1${path}`)).status).toBe(401)
  })
})

describe('PATCH /v1/calls/{callId}/copilot/cards/{cardId}', () => {
  const patch = (who: ReturnType<typeof identityOf>, card: string, body: unknown, on = callId) =>
    t.call(who, 'PATCH', `/calls/${on}/copilot/cards/${card}`, body)
  const rated = async () => {
    const out = []
    for (;;) {
      const got = await t.deps.events.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 1,
        waitSeconds: 0,
      })
      if (got.length === 0) {
        return out
      }
      for (const delivery of got) {
        if (delivery.kind === 'message') {
          out.push(delivery.envelope)
          await t.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }

  it('rates a card, and a repeat answers the same card and sends the same event id', async () => {
    const card = await seedCard(org, callId)
    const first = await patch(rep, card.id, { rating: 'useful' })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ rating: 'useful', dismissed: false, pinned: false })
    const again = await patch(rep, card.id, { rating: 'useful' })
    expect(again.body).toEqual(first.body)
    const events = await rated()
    expect(new Set(events.map((e) => e.id)).size).toBe(1)
    const changed = await patch(rep, card.id, { rating: 'not_useful' })
    expect(changed.status).toBe(200)
    expect(new Set([...events, ...(await rated())].map((e) => e.id)).size).toBe(2)
    const listed = await get(rep, `/calls/${callId}/copilot/cards`)
    expect((listed.body as { items: { rating: string }[] }).items[0]?.rating).toBe('not_useful')
  })

  it('delivers the event on a retry after a failed publish, under one id', async () => {
    const card = await seedCard(org, callId)
    const publish = t.deps.events.publish.bind(t.deps.events)
    let calls = 0
    t.deps.events.publish = async (...args) => {
      if (++calls === 1) {
        throw new Error('queue down')
      }
      return publish(...args)
    }
    expect((await patch(rep, card.id, { rating: 'useful' })).status).toBe(500)
    expect((await patch(rep, card.id, { rating: 'useful' })).status).toBe(200)
    const events = await rated()
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toMatch(/^evt_[0-9a-f]{32}$/)
  })

  it('clears a rating with null, and dismissing clears the pin', async () => {
    const card = await seedCard(org, callId)
    await patch(rep, card.id, { rating: 'not_useful', pinned: true })
    const dismissed = await patch(rep, card.id, { dismissed: true })
    expect(dismissed.body).toMatchObject({ rating: 'not_useful', dismissed: true, pinned: false })
    const cleared = await patch(rep, card.id, { rating: null })
    expect(cleared.body).toMatchObject({ rating: null, dismissed: true })
    expect((await patch(rep, card.id, { dismissed: true, pinned: true })).status).toBe(400)
  })

  it('is call.not_found for a Manager, an Admin, another Rep and another Organization', async () => {
    const card = await seedCard(org, callId)
    const other = identityOf('rep', org)
    t.deps.directory.addMembership(org, other.userId, formatId('mem', crypto.randomUUID()))
    for (const who of [identityOf('admin', org), other, identityOf('owner', newOrganizationId())]) {
      const response = await patch(who, card.id, { rating: 'useful' })
      expect(response.status).toBe(404)
      expect((response.body as { error: { code: string } }).error.code).toBe('call.not_found')
    }
    expect(await rated()).toHaveLength(0)
  })

  it('is card.not_found for a card of another Call', async () => {
    const elsewhere = await seedCall(org, repMembership)
    const card = await seedCard(org, elsewhere)
    const response = await patch(rep, card.id, { rating: 'useful' })
    expect(response.status).toBe(404)
    expect((response.body as { error: { code: string } }).error.code).toBe('card.not_found')
  })
})
