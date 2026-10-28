import { beforeEach, describe, expect, it } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { TELEPHONY_ERROR_CODES } from 'tula-closeline-kit'
import { createMemoryTelephony, type MemoryTelephony } from 'tula-closeline-kit/testing'
import { sweepStaleOutbound } from '~/modules/call/missed-sweep'
import * as Calls from '~/modules/call/service'
import { createCopilotRuntime } from '~/modules/transcript/runtime'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  reportStatus,
  ringUntilAnswered,
  type TestApp,
  type TestIdentity,
} from '~/testing'

type CallBody = {
  id: string
  state: string
  failureReason: string | null
  disclosure: { wordingVersion: number | null; aiAssisted: boolean }
  wrapUp?: { dealId: string | null; note: string | null }
  dealId?: string | null
  note?: string | null
}
type PlacedBody = { call: CallBody; warnings: unknown[] }
type PageBody = { items: CallBody[]; nextCursor: string | null }
type ErrorBody = { error: { code: string; details?: { callId?: string } } }

const PROSPECT = '+14155550100'
let n = 0
const nextKey = () => `place-call-key-${String(++n).padStart(6, '0')}`

let t: TestApp
let telephony: MemoryTelephony
let organizationId: ReturnType<typeof newOrganizationId>
let admin: TestIdentity
let rep: TestIdentity
let repMembership: string

const membershipFor = (who: TestIdentity): string => {
  const id = formatId('mem', crypto.randomUUID())
  t.deps.directory.addMembership(who.organizationId, who.userId, id)
  t.deps.directory.addRep(who.organizationId, id)
  return id
}

/** Buys a Line as the admin and assigns it to the Rep, returning its id. */
async function lineFor(membershipId: string): Promise<string> {
  const bought = await t.call(admin, 'POST', '/lines', { method: 'buy', country: 'US' })
  const id = (bought.body as { id: string }).id
  await t.call(admin, 'PUT', `/lines/${id}/assignment`, { kind: 'rep', membershipId })
  return id
}

beforeEach(async () => {
  telephony = createMemoryTelephony()
  t = await createTestApp({ telephony })
  organizationId = newOrganizationId()
  admin = identityOf('admin', organizationId)
  rep = identityOf('rep', organizationId)
  repMembership = membershipFor(rep)
  await lineFor(repMembership)
  telephony.script(PROSPECT, { kind: 'answers' })
})

/** Posts /v1/calls as `who`. */
async function place(who: TestIdentity, body: unknown, key: string | null = nextKey()) {
  const response = await t.app.request('/v1/calls', {
    method: 'POST',
    headers: {
      ...(await t.bearer(who)),
      'content-type': 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/** The Prospect picks up: the provider reports `in-progress` and the setup runs to its end. */
const answer = (callId: string, status = 'in-progress', sequence = '1') =>
  reportStatus(t, telephony, organizationId, callId, status, sequence)

/** Places a Call and has the Prospect answer, so it has run to `live` or to its failure. */
async function placeAnswered(who: TestIdentity, body: unknown) {
  const placed = await place(who, body)
  await answer((placed.body as PlacedBody).call.id)
  return placed
}

const stateOf = async (callId: string) =>
  (await t.call(rep, 'GET', `/calls/${callId}`)).body as CallBody

const codeOf = (body: unknown): string => (body as ErrorBody).error.code

describe('placing a Call', () => {
  it('leaves the Call ringing and plays nothing until the Prospect answers', async () => {
    const ringing = ringUntilAnswered(createMemoryTelephony())
    telephony = ringing
    t = await createTestApp({ telephony })
    organizationId = newOrganizationId()
    admin = identityOf('admin', organizationId)
    rep = identityOf('rep', organizationId)
    await lineFor(membershipFor(rep))
    const { status, body } = await place(rep, { to: PROSPECT })
    const placed = body as PlacedBody
    expect(status).toBe(201)
    expect(placed.call.state).toBe('ringing')
    expect(placed.call.disclosure.wordingVersion).toBeNull()
    expect(telephony.operations.map((entry) => entry.operation)).toEqual(['placeCall'])

    await answer(placed.call.id, 'ringing', '0')
    expect((await stateOf(placed.call.id)).state).toBe('ringing')
    expect(telephony.operations.map((entry) => entry.operation)).toEqual(['placeCall'])

    const sid = (await t.deps.calls.get(organizationId, placed.call.id as never))?.providerCallSid
    ringing.answer(sid as string)
    await answer(placed.call.id)
    expect((await stateOf(placed.call.id)).state).toBe('live')
    expect(telephony.operations.map((entry) => entry.operation)).toEqual([
      'placeCall',
      'playDisclosure',
      'bridge',
      'startRecording',
    ])
  })

  it('plays the Disclosure before the Rep is bridged and the Recording starts, then goes live', async () => {
    const { status, body } = await placeAnswered(rep, { to: PROSPECT })
    expect(status).toBe(201)
    const placed = body as PlacedBody
    expect(placed.warnings).toEqual([])
    const call = await stateOf(placed.call.id)
    expect(call.state).toBe('live')
    expect(call.disclosure.wordingVersion).toBe(Calls.DISCLOSURE_WORDING.version)
    expect(call.disclosure.aiAssisted).toBe(false)

    const order = telephony.operations.map((entry) => entry.operation)
    expect(order).toEqual(['placeCall', 'playDisclosure', 'bridge', 'startRecording'])

    const events = await t.deps.calls.events(organizationId, placed.call.id as never)
    const kinds = events.map((entry) => entry.kind)
    expect(kinds.indexOf('disclosure_played')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('disclosure_played')).toBeLessThan(kinds.indexOf('recording_started'))
  })

  it('does not set the Disclosure up twice for a repeated or late answered report', async () => {
    const { body } = await placeAnswered(rep, { to: PROSPECT })
    const id = (body as PlacedBody).call.id
    await answer(id)
    await answer(id, 'in-progress', '2')
    await answer(id, 'completed', '3')
    const ops = telephony.operations.map((entry) => entry.operation)
    expect(ops.filter((op) => op === 'playDisclosure')).toHaveLength(1)
    expect(ops.filter((op) => op === 'bridge')).toHaveLength(1)
    expect((await stateOf(id)).state).toBe('live')
  })

  it.each([
    ['no-answer', 'no_answer'],
    ['busy', 'busy'],
    ['failed', 'provider_error'],
    ['canceled', 'carrier_dropped'],
  ])(
    'fails a ringing Call the provider reports %s, and plays no Disclosure',
    async (report, reason) => {
      const { body } = await place(rep, { to: PROSPECT })
      const id = (body as PlacedBody).call.id
      await answer(id, report)
      const call = await stateOf(id)
      expect(call.state).toBe('failed')
      expect(call.failureReason).toBe(reason)
      await answer(id, 'in-progress', '2')
      expect((await stateOf(id)).state).toBe('failed')
      expect(telephony.operations.map((entry) => entry.operation)).not.toContain('playDisclosure')
    }
  )

  it('uses the stored Copilot setting when another instance receives the answer', async () => {
    const { body } = await place(rep, { to: PROSPECT, copilot: true })
    const id = (body as PlacedBody).call.id
    // A fresh process memory stands for another instance or a restart.
    Object.assign(t.deps, { copilot: createCopilotRuntime() })
    await answer(id)
    const call = await stateOf(id)
    expect(call.state).toBe('live')
    expect(call.disclosure.aiAssisted).toBe(true)
  })

  it('never returns the provider id', async () => {
    const { body } = await place(rep, { to: PROSPECT })
    expect(JSON.stringify(body)).not.toContain('providerCallSid')
  })

  it('ends the Call failed, never live, when the Disclosure does not play', async () => {
    telephony.script(PROSPECT, { kind: 'hangs_up', when: 'during_disclosure' })
    const { body } = await placeAnswered(rep, { to: PROSPECT })
    const callId = (body as PlacedBody).call.id
    const call = await stateOf(callId)
    expect(call.state).toBe('failed')
    expect(call.failureReason).toBe('disclosure_failed')
    const events = await t.deps.calls.events(organizationId, callId as never)
    expect(events.map((entry) => entry.kind)).not.toContain('recording_started')
    expect(telephony.operations.map((entry) => entry.operation)).not.toContain('bridge')
  })

  it('fails the Call with a timeout reason when the carrier is unavailable', async () => {
    telephony.failNext('placeCall', TELEPHONY_ERROR_CODES.unavailable)
    const { status, body } = await place(rep, { to: PROSPECT })
    expect(status).toBe(503)
    expect(codeOf(body)).toBe('server.unavailable')
    const page = (await t.call(rep, 'GET', '/calls')).body as PageBody
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.state).toBe('failed')
    expect(page.items[0]?.failureReason).toBe('timeout')
  })

  it('fails a Call the carrier rejects as carrier_rejected', async () => {
    telephony.failNext('placeCall', TELEPHONY_ERROR_CODES.rejected)
    await place(rep, { to: PROSPECT })
    const page = (await t.call(rep, 'GET', '/calls')).body as PageBody
    expect(page.items[0]?.failureReason).toBe('carrier_rejected')
  })

  it('fails a Call as provider_error when the Rep cannot be bridged after the Disclosure', async () => {
    telephony.failNext('bridge', TELEPHONY_ERROR_CODES.unavailable)
    const { status } = await placeAnswered(rep, { to: PROSPECT })
    expect(status).toBe(201)
    const page = (await t.call(rep, 'GET', '/calls')).body as PageBody
    expect(page.items[0]?.state).toBe('failed')
    expect(page.items[0]?.failureReason).toBe('provider_error')
  })

  it('places exactly one Call for the same Idempotency-Key', async () => {
    const key = nextKey()
    const first = await place(rep, { to: PROSPECT }, key)
    const again = await place(rep, { to: PROSPECT }, key)
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect((again.body as PlacedBody).call.id).toBe((first.body as PlacedBody).call.id)
    expect(telephony.operations.filter((entry) => entry.operation === 'placeCall')).toHaveLength(1)
    const page = (await t.call(rep, 'GET', '/calls')).body as PageBody
    expect(page.items).toHaveLength(1)
  })

  it('answers a replay with the Call as it is now, not as it was when placed', async () => {
    telephony.script(PROSPECT, { kind: 'hangs_up', when: 'during_disclosure' })
    const key = nextKey()
    const first = await place(rep, { to: PROSPECT }, key)
    expect(first.status).toBe(201)
    await answer((first.body as PlacedBody).call.id)
    const again = await place(rep, { to: PROSPECT }, key)
    expect(again.status).toBe(200)
    expect((again.body as PlacedBody).call.state).toBe('failed')
  })

  it('refuses the same key with another request', async () => {
    const key = nextKey()
    await place(rep, { to: PROSPECT }, key)
    const other = await place(rep, { to: '+14155550111' }, key)
    expect(other.status).toBe(422)
    expect(codeOf(other.body)).toBe('request.idempotency_key_reused')
  })

  it('needs an Idempotency-Key', async () => {
    const { status, body } = await place(rep, { to: PROSPECT }, null)
    expect(status).toBe(400)
    expect(codeOf(body)).toBe('request.invalid')
  })

  it('accepts a formatted number with a country code', async () => {
    telephony.script('+14155550123', { kind: 'answers' })
    const { status } = await place(rep, { to: '+1 (415) 555-0123' })
    expect(status).toBe(201)
  })

  for (const to of ['4155550100', '+0155550100', '+1415', '+1415555010012345', '+1 4155 55x']) {
    it(`answers call.number_invalid for ${to}`, async () => {
      const { status, body } = await place(rep, { to })
      expect(status === 422 || status === 400).toBe(true)
      expect(['call.number_invalid', 'request.invalid']).toContain(codeOf(body))
    })
  }

  it('answers 422 call.number_invalid for a number without a country code', async () => {
    const { status, body } = await place(rep, { to: '4155550100' })
    expect(status).toBe(422)
    expect(codeOf(body)).toBe('call.number_invalid')
  })

  it('answers call.line_unavailable when the Rep has no Line', async () => {
    const other = identityOf('rep', organizationId)
    membershipFor(other)
    const { status, body } = await place(other, { to: PROSPECT })
    expect(status).toBe(409)
    expect(codeOf(body)).toBe('call.line_unavailable')
  })

  it('answers line.not_found for a Line of another Organization', async () => {
    const otherAdmin = identityOf('admin')
    const bought = await t.call(otherAdmin, 'POST', '/lines', { method: 'buy', country: 'US' })
    const lineId = (bought.body as { id: string }).id
    const { status, body } = await place(rep, { to: PROSPECT, lineId })
    expect(status).toBe(404)
    expect(codeOf(body)).toBe('line.not_found')
  })

  it('refuses a caller without a Membership', async () => {
    const stranger = identityOf('rep', organizationId)
    const { status, body } = await place(stranger, { to: PROSPECT })
    expect(status).toBe(403)
    expect(codeOf(body)).toBe('auth.forbidden')
  })
})

describe('who sees which Calls', () => {
  it('shows a Rep their own Calls, a Manager the Team, an Admin all, and Organization B none', async () => {
    const rep2 = identityOf('rep', organizationId)
    const rep2Membership = membershipFor(rep2)
    await lineFor(rep2Membership)
    const outsider = identityOf('rep', organizationId)
    const outsiderMembership = membershipFor(outsider)
    await lineFor(outsiderMembership)
    const manager = identityOf('manager', organizationId)
    const managerMembership = formatId('mem', crypto.randomUUID())
    t.deps.directory.addMembership(organizationId, manager.userId, managerMembership)
    t.deps.directory.addTeamReps(organizationId, managerMembership, [repMembership, rep2Membership])

    const own = (await place(rep, { to: PROSPECT })).body as PlacedBody
    const teammate = (await place(rep2, { to: PROSPECT })).body as PlacedBody
    const other = (await place(outsider, { to: PROSPECT })).body as PlacedBody

    const idsOf = async (who: TestIdentity) =>
      ((await t.call(who, 'GET', '/calls')).body as PageBody).items.map((call) => call.id).sort()

    expect(await idsOf(rep)).toEqual([own.call.id])
    expect(await idsOf(manager)).toEqual([own.call.id, teammate.call.id].sort())
    expect(await idsOf(admin)).toEqual([own.call.id, teammate.call.id, other.call.id].sort())

    const orgB = identityOf('admin')
    expect(await idsOf(orgB)).toEqual([])
    for (const id of [own.call.id, teammate.call.id, other.call.id]) {
      const read = await t.call(orgB, 'GET', `/calls/${id}`)
      expect(read.status).toBe(404)
      expect(codeOf(read.body)).toBe('call.not_found')
    }
    expect((await t.call(rep, 'GET', `/calls/${teammate.call.id}`)).status).toBe(404)
    expect((await t.call(manager, 'GET', `/calls/${teammate.call.id}`)).status).toBe(200)
    expect((await t.call(manager, 'GET', `/calls/${other.call.id}`)).status).toBe(404)
  })

  it('pages with a cursor, newest first', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      t.deps.clock.advance('1s')
      ids.push(((await place(rep, { to: PROSPECT })).body as PlacedBody).call.id)
    }
    const first = (await t.call(rep, 'GET', '/calls?limit=2')).body as PageBody
    expect(first.items.map((call) => call.id)).toEqual([ids[2], ids[1]] as string[])
    expect(first.nextCursor).not.toBeNull()
    const second = (await t.call(rep, 'GET', `/calls?limit=2&cursor=${first.nextCursor}`))
      .body as PageBody
    expect(second.items.map((call) => call.id)).toEqual([ids[0]] as string[])
    expect(second.nextCursor).toBeNull()
  })

  it('answers request.invalid for a cursor that is not ours', async () => {
    const { status, body } = await t.call(rep, 'GET', '/calls?cursor=nonsense')
    expect(status).toBe(400)
    expect(codeOf(body)).toBe('request.invalid')
  })
})

describe('wrapping up a Call', () => {
  let callId: string

  beforeEach(async () => {
    callId = ((await placeAnswered(rep, { to: PROSPECT })).body as PlacedBody).call.id
  })

  const wrap = (who: TestIdentity) =>
    t.call(who, 'PUT', `/calls/${callId}/wrap-up`, { note: 'Booked a demo' })

  it('answers call.not_ended while the Call is live', async () => {
    const { status, body } = await wrap(rep)
    expect(status).toBe(409)
    expect(codeOf(body)).toBe('call.not_ended')
  })

  it('lets the Rep and an Admin wrap up an ended Call, and hides it from others', async () => {
    await Calls.end(t.deps, organizationId, callId as never, {
      by: 'prospect',
      at: t.deps.clock.now(),
    })
    const manager = identityOf('manager', organizationId)
    t.deps.directory.addMembership(
      organizationId,
      manager.userId,
      formatId('mem', crypto.randomUUID())
    )
    const other = identityOf('rep', organizationId)
    membershipFor(other)

    expect((await wrap(manager)).status).toBe(404)
    expect((await wrap(other)).status).toBe(404)
    const ok = await wrap(rep)
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.body)).toContain('Booked a demo')
    expect((await wrap(admin)).status).toBe(200)
  })
})

describe('sweeping outbound Calls that never progressed', () => {
  const sweepOutbound = (after: string) => {
    t.deps.clock.advance(after)
    return sweepStaleOutbound(t.deps, { maxOrganizations: 100, shouldStop: () => false })
  }

  it('fails a Call still ringing long after the ring time, and hangs up', async () => {
    const { body } = await place(rep, { to: PROSPECT })
    const id = (body as PlacedBody).call.id
    expect(await sweepOutbound('60s')).toBe(0)
    expect(await sweepOutbound('60s')).toBe(1)
    const call = await stateOf(id)
    expect(call.state).toBe('failed')
    expect(call.failureReason).toBe('no_answer')
    expect(telephony.operations.map((entry) => entry.operation)).toContain('hangUp')
    expect(await sweepOutbound('60s')).toBe(0)
  })

  it('fails a Call stuck connecting as provider_error', async () => {
    const { body } = await place(rep, { to: PROSPECT })
    const id = (body as PlacedBody).call.id
    await t.deps.calls.transition(organizationId, id as never, {
      to: 'connecting',
      at: t.deps.clock.now(),
    })
    expect(await sweepOutbound('3m')).toBe(1)
    expect((await stateOf(id)).failureReason).toBe('provider_error')
  })

  it('leaves a live Call alone', async () => {
    const { body } = await placeAnswered(rep, { to: PROSPECT })
    const id = (body as PlacedBody).call.id
    expect(await sweepOutbound('3m')).toBe(0)
    expect((await stateOf(id)).state).toBe('live')
  })
})
