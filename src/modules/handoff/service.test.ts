import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  AGENT_ERRORS,
  ERRORS,
  formatId,
  type Handoff,
  type OrganizationId,
  type VoiceCall,
} from 'tula-closeline-contract'
import { TELEPHONY_ERROR_CODES } from 'tula-closeline-kit'
import {
  createMemoryTelephony,
  createMemoryTts,
  type MemoryTelephony,
  type MemoryTts,
} from 'tula-closeline-kit/testing'
import * as AgentCall from '~/modules/agent-call/service'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import { HANDOFF_DISCLOSURE_WORDING } from '~/modules/call/service'
import {
  createTestDeps,
  identityOf,
  newOrganizationId,
  type TestDeps,
  type TestIdentity,
} from '~/testing'
import * as Handoffs from './service'

const AUDIO = new Uint8Array([1, 2, 3, 4])
const TEAM = formatId('team', crypto.randomUUID())

let t: TestDeps
let deps: AgentCall.AgentCallDeps
let telephony: MemoryTelephony
let tts: MemoryTts
let org: OrganizationId
const sink: AgentCall.AudioSink = () => undefined

/** What a Rep does when their offer rings: `accept`, `decline`, or `ignore` it. */
type Move = 'accept' | 'decline' | 'ignore'

type Rep = { membershipId: NonNullable<Handoff['repMembershipId']>; identity: TestIdentity }

function addRep(forOrg = org): Rep {
  const identity = identityOf('rep', forOrg)
  const membershipId = formatId('mem', crypto.randomUUID()) as Rep['membershipId']
  t.directory.addRep(forOrg, membershipId)
  t.directory.addMembership(forOrg, identity.userId, membershipId)
  return { membershipId, identity }
}

/** Scripts the Reps' answers: the n-th ring is answered with the n-th move; each tick takes 500 ms. */
function script(reps: Rep[], moves: Move[]) {
  let ring = -1
  let seen = ''
  t.sleep = async () => {
    t.clock.advance('500ms')
    const offers = await t.handoffs.forCall(org, callIdOf())
    const open = offers.find((offer) => offer.state === 'pending')
    if (open === undefined) {
      return
    }
    if (open.id !== seen) {
      seen = open.id
      ring += 1
    }
    const move = moves[ring] ?? 'ignore'
    const rep = reps.find((candidate) => candidate.membershipId === open.repMembershipId)
    if (rep === undefined || move === 'ignore') {
      return
    }
    await (move === 'accept' ? Handoffs.accept : Handoffs.decline)(deps, rep.identity, open.id)
  }
}

let currentCall: VoiceCall['id']
const callIdOf = () => currentCall

/** A live Agent Call on a Team Line, with two exchanges already in the conversation. */
async function liveCall(forOrg = org) {
  const lineId = formatId('line', crypto.randomUUID()) as never
  await t.lines.insert(forOrg, {
    id: lineId,
    number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: t.clock.now(),
  })
  await t.lines.assign(forOrg, lineId, { kind: 'team', teamId: TEAM } as never)
  const id = formatId('call', crypto.randomUUID()) as VoiceCall['id']
  const providerCallId = telephony.receiveInbound(forOrg as never, '+14155550100', '+14155550199')
  await telephony.answerCall({
    organizationId: forOrg as never,
    providerCallId,
    callId: id,
    ringIdentities: [formatId('mem', crypto.randomUUID())],
  })
  await t.calls.insertInbound(forOrg, {
    id,
    lineId,
    repMembershipId: null,
    callerNumber: '+14155550100',
    providerCallSid: providerCallId,
    createdAt: t.clock.now(),
  })
  tts.speak([AUDIO])
  tts.speak([AUDIO])
  await AgentCall.answer(deps, { organizationId: forOrg, callId: id, providerCallId, sink })
  await t.turns.append(
    forOrg,
    { kind: 'call', id },
    {
      index: 0,
      role: 'prospect',
      text: 'I need pricing for ten seats.',
      deferred: false,
      toolName: null,
      sources: [],
    }
  )
  await t.turns.append(
    forOrg,
    { kind: 'call', id },
    {
      index: 1,
      role: 'agent',
      text: 'Ten seats on the Team plan is 400 dollars.',
      deferred: false,
      toolName: null,
      sources: [],
    }
  )
  currentCall = id
  return id
}

const start = (callId: VoiceCall['id'], reason: Handoff['reason'] = 'asked_for_rep') =>
  Handoffs.start(deps, { organizationId: org, callId, reason })

beforeEach(() => {
  telephony = createMemoryTelephony()
  tts = createMemoryTts({ sleep: async () => undefined, random: () => 0 })
  t = createTestDeps({ telephony })
  deps = Object.assign(t, { tts })
  org = newOrganizationId()
})

describe('a warm Handoff', () => {
  test('plays the Disclosure before the bridge, then the Copilot starts with the earlier turns', async () => {
    const [rep] = [addRep()]
    t.directory.setOnlineReps(org, TEAM, [rep.membershipId])
    const callId = await liveCall()
    script([rep], ['accept'])

    const outcome = await start(callId)

    expect(outcome.kind).toBe('bridged')
    const operations = telephony.operations.map((operation) => operation.operation)
    expect(operations.lastIndexOf('playDisclosure')).toBeLessThan(operations.indexOf('bridge'))
    const stored = await t.calls.get(org, callId)
    expect(stored?.repMembershipId).toBe(rep.membershipId)
    expect(stored?.disclosure).toMatchObject({
      wordingVersion: HANDOFF_DISCLOSURE_WORDING.version,
      aiAssisted: true,
    })
    const turns = await t.callTurns.list(org, callId, { rep: 0, prospect: 0 }, 50)
    expect(turns.map((turn) => turn.text)).toEqual([
      'I need pricing for ten seats.',
      'Ten seats on the Team plan is 400 dollars.',
    ])
    expect(t.copilot.streams.has(callId)).toBe(true)
  })

  test('stores the timing: requested, answered, completed', async () => {
    const rep = addRep()
    t.directory.setOnlineReps(org, TEAM, [rep.membershipId])
    const callId = await liveCall()
    script([rep], ['accept'])

    await start(callId)

    const [handoff] = await t.handoffs.forCall(org, callId)
    expect(handoff?.state).toBe('completed')
    expect(handoff?.requestedAt).toBeString()
    expect(handoff?.answeredAt).toBeString()
    expect(handoff?.completedAt).toBeString()
    expect(Date.parse(handoff?.completedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(handoff?.answeredAt ?? '')
    )
  })

  test('falls back to the next Rep when the first declines', async () => {
    const [first, second] = [addRep(), addRep()]
    t.directory.setOnlineReps(org, TEAM, [first.membershipId, second.membershipId])
    const callId = await liveCall()
    script([first, second], ['decline', 'accept'])

    const outcome = await start(callId)

    expect(outcome.kind).toBe('bridged')
    const handoffs = await t.handoffs.forCall(org, callId)
    expect(handoffs.map((handoff) => [handoff.attempt, handoff.state])).toEqual([
      [1, 'declined'],
      [2, 'completed'],
    ])
    expect((await t.calls.get(org, callId))?.repMembershipId).toBe(second.membershipId)
  })

  test('falls back when the first Rep does not answer within the ring timeout', async () => {
    const [first, second] = [addRep(), addRep()]
    t.directory.setOnlineReps(org, TEAM, [first.membershipId, second.membershipId])
    const callId = await liveCall()
    script([first, second], ['ignore', 'accept'])

    const outcome = await start(callId)

    expect(outcome.kind).toBe('bridged')
    const handoffs = await t.handoffs.forCall(org, callId)
    expect(handoffs.map((handoff) => handoff.state)).toEqual(['timed_out', 'completed'])
  })

  test('offers a Booking when no Rep answers, and the Call keeps the Agent', async () => {
    const [first, second] = [addRep(), addRep()]
    t.directory.setOnlineReps(org, TEAM, [first.membershipId, second.membershipId])
    const callId = await liveCall()
    script([first, second], ['decline', 'ignore'])

    const outcome = await start(callId)

    expect(outcome.kind).toBe('booking_offered')
    const handoffs = await t.handoffs.forCall(org, callId)
    expect(handoffs.map((handoff) => handoff.state)).toEqual(['declined', 'timed_out', 'no_rep'])
    expect(handoffs[2]?.completedAt).toBeString()
    const stored = await t.calls.get(org, callId)
    expect(stored?.repMembershipId).toBeNull()
    expect(telephony.operations.map((operation) => operation.operation)).not.toContain('bridge')
  })

  test('with nobody online at all it records no_rep at once', async () => {
    const callId = await liveCall()
    script([], [])

    expect((await start(callId)).kind).toBe('booking_offered')
    expect((await t.handoffs.forCall(org, callId)).map((handoff) => handoff.state)).toEqual([
      'no_rep',
    ])
  })

  test('does nothing for a Call that has a Rep, or that already has a Handoff', async () => {
    const rep = addRep()
    t.directory.setOnlineReps(org, TEAM, [rep.membershipId])
    const callId = await liveCall()
    script([rep], ['accept'])
    await start(callId)
    expect((await start(callId)).kind).toBe('not_live')

    const other = await liveCall()
    await t.handoffs.noRep(org, {
      callId: other,
      reason: 'qualified',
      attempt: 1,
      at: t.clock.now(),
    })
    expect((await start(other)).kind).toBe('already')
  })

  test('a bridge that fails abandons the Handoff and offers a Booking', async () => {
    const rep = addRep()
    t.directory.setOnlineReps(org, TEAM, [rep.membershipId])
    const callId = await liveCall()
    script([rep], ['accept'])
    telephony.failNext('bridge', TELEPHONY_ERROR_CODES.rejected)

    const outcome = await start(callId)

    expect(outcome.kind).toBe('booking_offered')
    expect((await t.calls.get(org, callId))?.repMembershipId).toBeNull()
  })

  test('a failure after the bridge does not undo it: the Handoff still completes', async () => {
    const rep = addRep()
    t.directory.setOnlineReps(org, TEAM, [rep.membershipId])
    const callId = await liveCall()
    script([rep], ['accept'])
    const append = spyOn(t.callTurns, 'append').mockRejectedValue(new Error('db down'))

    const outcome = await start(callId)
    append.mockRestore()

    expect(outcome.kind).toBe('bridged')
    expect((await t.handoffs.forCall(org, callId)).map((h) => h.state)).toEqual(['completed'])
  })

  test("another Organization's Call is not live to this one", async () => {
    const callId = await liveCall()
    const outcome = await Handoffs.start(deps, {
      organizationId: newOrganizationId() as never,
      callId,
      reason: 'asked_for_rep',
    })
    expect(outcome.kind).toBe('not_live')
  })
})

describe('answering an offer', () => {
  async function offered() {
    const rep = addRep()
    const callId = await liveCall()
    const handoff = await t.handoffs.offer(org, {
      callId,
      repMembershipId: rep.membershipId,
      attempt: 1,
      reason: 'asked_for_rep',
      at: t.clock.now(),
    })
    if (handoff === undefined) {
      throw new Error('offer refused')
    }
    return { rep, handoff }
  }

  test('accept and a repeat both answer the same Handoff', async () => {
    const { rep, handoff } = await offered()
    const first = await Handoffs.accept(deps, rep.identity, handoff.id)
    const again = await Handoffs.accept(deps, rep.identity, handoff.id)
    expect(first.state).toBe('accepted')
    expect(again).toEqual(first)
  })

  test('decline, then accept is not pending', async () => {
    const { rep, handoff } = await offered()
    expect((await Handoffs.decline(deps, rep.identity, handoff.id)).state).toBe('declined')
    expect((await Handoffs.decline(deps, rep.identity, handoff.id)).state).toBe('declined')
    await expect(Handoffs.accept(deps, rep.identity, handoff.id)).rejects.toMatchObject({
      code: AGENT_ERRORS['handoff.not_pending'].code,
    })
  })

  test("another Rep's offer is not found", async () => {
    const { handoff } = await offered()
    const other = addRep()
    await expect(Handoffs.accept(deps, other.identity, handoff.id)).rejects.toMatchObject({
      code: AGENT_ERRORS['handoff.not_found'].code,
    })
  })

  test("another Organization's Rep cannot see the offer", async () => {
    const { handoff } = await offered()
    const otherOrg = newOrganizationId()
    const stranger = addRep(otherOrg)
    await expect(Handoffs.accept(deps, stranger.identity, handoff.id)).rejects.toMatchObject({
      code: AGENT_ERRORS['handoff.not_found'].code,
    })
    expect(await t.handoffs.get(otherOrg, handoff.id)).toBeUndefined()
  })

  test('a role that does not take Calls is forbidden', async () => {
    const { handoff } = await offered()
    await expect(
      Handoffs.accept(deps, identityOf('viewer' as never, org), handoff.id)
    ).rejects.toMatchObject({ code: ERRORS['auth.forbidden'].code })
  })
})

describe('the Agent hands off', () => {
  beforeEach(async () => {
    await t.agentSettings.put(org, {
      ...DEFAULT_AGENT_SETTINGS,
      hours: [...DEFAULT_AGENT_SETTINGS.hours],
      paused: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  const reply = (over: Record<string, unknown>) =>
    JSON.stringify({
      reply: 'Let me get someone.',
      sources: ['P1'],
      deferred: false,
      toolCall: null,
      ...over,
    })

  test('a hand_off tool call bridges the Rep and the Agent stops', async () => {
    const rep = addRep()
    t.directory.setOnlineReps(org, TEAM, [rep.membershipId])
    const callId = await liveCall()
    script([rep], ['accept'])
    t.evidence.load(org, {
      documents: [
        {
          documentId: formatId('doc', crypto.randomUUID()) as never,
          fileName: 'a.pdf',
          page: 1,
          score: 0.9,
          snippet: 'Plans exist.',
        },
      ],
    })
    t.llm.reply(reply({ toolCall: { name: 'hand_off', arguments: { reason: 'asked_for_rep' } } }))

    const outcome = await AgentCall.hear(deps, {
      organizationId: org,
      callId,
      text: 'Can I talk to a person?',
      audioSeconds: 2,
      sink,
    })

    expect(outcome.kind).toBe('handed_off')
    expect((await t.calls.get(org, callId))?.repMembershipId).toBe(rep.membershipId)
  })

  test('after the Rep joined, the Agent no longer answers the Prospect', async () => {
    const rep = addRep()
    t.directory.setOnlineReps(org, TEAM, [rep.membershipId])
    const callId = await liveCall()
    script([rep], ['accept'])
    await start(callId)
    t.llm.reply(reply({}))

    const outcome = await AgentCall.hear(deps, {
      organizationId: org,
      callId,
      text: 'Hello?',
      audioSeconds: 1,
      sink,
    })

    expect(outcome.kind).toBe('handed_off')
  })

  test('with no Rep available the Agent offers a Booking instead', async () => {
    const callId = await liveCall()
    script([], [])
    t.evidence.load(org, {
      documents: [
        {
          documentId: formatId('doc', crypto.randomUUID()) as never,
          fileName: 'a.pdf',
          page: 1,
          score: 0.9,
          snippet: 'Plans exist.',
        },
      ],
    })
    t.llm.reply(reply({ toolCall: { name: 'hand_off', arguments: { reason: 'asked_for_rep' } } }))
    tts.speak([AUDIO])
    tts.speak([AUDIO])
    tts.speak([AUDIO])

    const outcome = await AgentCall.hear(deps, {
      organizationId: org,
      callId,
      text: 'Can I talk to a person?',
      audioSeconds: 2,
      sink,
    })

    expect(outcome.kind).toBe('replied')
    // the greeting's two sentences, the reply, and the booking line
    expect(tts.requests().length).toBeGreaterThan(3)
    expect((await t.handoffs.forCall(org, callId)).map((handoff) => handoff.state)).toEqual([
      'no_rep',
    ])
  })
})
