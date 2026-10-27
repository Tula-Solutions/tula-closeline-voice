import { beforeEach, describe, expect, test } from 'bun:test'
import { formatId, type VoiceCall } from 'tula-closeline-contract'
import { TELEPHONY_ERROR_CODES } from 'tula-closeline-kit'
import {
  createMemoryTelephony,
  createMemoryTts,
  type MemoryTelephony,
  type MemoryTts,
} from 'tula-closeline-kit/testing'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import { AGENT_DISCLOSURE_WORDING } from '~/modules/call/service'
import type { DocumentMatch } from '~/ports/evidence-search'
import { createTestDeps, newOrganizationId, type TestDeps } from '~/testing'
import * as AgentCall from './service'

const DOC = formatId('doc', crypto.randomUUID())
const AUDIO = new Uint8Array([1, 2, 3, 4])
const ONE = 'The Team plan costs 40 dollars a seat.'
const TWO = 'It includes unlimited Calls.'

let t: TestDeps
let deps: AgentCall.AgentCallDeps
let telephony: MemoryTelephony
let tts: MemoryTts
let org: string
const audio: number[] = []
const sink: AgentCall.AudioSink = (chunk) => void audio.push(chunk.sequence)

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply: `${ONE} ${TWO}`,
    sources: ['P1'],
    deferred: false,
    toolCall: null,
    ...over,
  })

async function settings(over: Partial<typeof DEFAULT_AGENT_SETTINGS> = {}) {
  await t.agentSettings.put(org, {
    ...DEFAULT_AGENT_SETTINGS,
    hours: [...DEFAULT_AGENT_SETTINGS.hours],
    paused: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  })
}

/** A ringing inbound Call at the provider and in the store, connected at the provider. */
async function ringing(forOrg = org) {
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
    lineId: formatId('line', crypto.randomUUID()),
    repMembershipId: null,
    callerNumber: '+14155550100',
    providerCallSid: providerCallId,
    createdAt: t.clock.now(),
  })
  return { id, providerCallId }
}

async function live() {
  const call = await ringing()
  tts.speak([AUDIO])
  tts.speak([AUDIO])
  const outcome = await AgentCall.answer(deps, {
    organizationId: org,
    callId: call.id,
    providerCallId: call.providerCallId,
    sink,
  })
  expect(outcome.kind).toBe('live')
  return call
}

const say = (callId: VoiceCall['id'], over: Partial<Parameters<typeof AgentCall.hear>[1]> = {}) =>
  AgentCall.hear(deps, {
    organizationId: org,
    callId,
    text: 'How much is the Team plan?',
    audioSeconds: 2,
    sink,
    ...over,
  })

const turnsOf = async (callId: string) =>
  t.turns.recent(org, { kind: 'call', id: callId }, 1000, 50)

beforeEach(async () => {
  audio.length = 0
  telephony = createMemoryTelephony()
  tts = createMemoryTts({ sleep: async () => undefined, random: () => 0 })
  t = createTestDeps({ telephony })
  t.numberTimeoutMs = 50
  deps = Object.assign(t, { tts })
  org = newOrganizationId()
  await settings()
  t.evidence.load(org, {
    documents: [
      {
        documentId: DOC as DocumentMatch['documentId'],
        fileName: 'pricing.pdf',
        page: 2,
        score: 0.9,
        snippet: ONE,
      },
    ],
  })
})

describe('the Disclosure comes first on an Agent Call', () => {
  test('plays the AI Disclosure, then records, then goes live, then greets; the model is not asked', async () => {
    const call = await ringing()
    tts.speak([AUDIO])
    tts.speak([AUDIO])
    const outcome = await AgentCall.answer(deps, {
      organizationId: org,
      callId: call.id,
      providerCallId: call.providerCallId,
      sink,
    })
    expect(outcome.kind).toBe('live')
    const stored = await t.calls.get(org, call.id)
    expect(stored?.state).toBe('live')
    expect(stored?.disclosure).toMatchObject({
      wordingVersion: AGENT_DISCLOSURE_WORDING.version,
      aiAssisted: true,
    })
    const operations = telephony.operations.map((operation) => operation.operation)
    expect(operations.indexOf('playDisclosure')).toBeLessThan(operations.indexOf('startRecording'))
    // the default greeting is two sentences, one stream each
    expect(tts.requests()).toHaveLength(2)
    expect(audio).toHaveLength(2)
    expect(t.llm.requests()).toHaveLength(0)
  })

  test('a delayed Disclosure never reaches live: no greeting and no model call', async () => {
    const call = await ringing()
    telephony.stallNext('playDisclosure')
    const outcome = await AgentCall.answer(deps, {
      organizationId: org,
      callId: call.id,
      providerCallId: call.providerCallId,
      sink,
    })
    expect(outcome.kind).toBe('disclosure_failed')
    const stored = await t.calls.get(org, call.id)
    expect(stored).toMatchObject({ state: 'failed', failureReason: 'disclosure_failed' })
    expect(stored?.answeredAt).toBeNull()
    expect(tts.requests()).toHaveLength(0)
    expect(audio).toEqual([])
    expect(await say(call.id)).toEqual({ kind: 'not_live' })
    expect(t.llm.requests()).toHaveLength(0)
  })

  test('a failed Disclosure never reaches live: no greeting and no model call', async () => {
    const call = await ringing()
    telephony.failNext('playDisclosure', TELEPHONY_ERROR_CODES.rejected)
    const outcome = await AgentCall.answer(deps, {
      organizationId: org,
      callId: call.id,
      providerCallId: call.providerCallId,
      sink,
    })
    expect(outcome.kind).toBe('disclosure_failed')
    expect((await t.calls.get(org, call.id))?.state).toBe('failed')
    expect(tts.requests()).toHaveLength(0)
    expect(await say(call.id)).toEqual({ kind: 'not_live' })
    expect(t.llm.requests()).toHaveLength(0)
  })

  test('a Call a Rep already holds is not answered by the Agent', async () => {
    const call = await ringing()
    await t.calls.claimInbound(org, call.id, formatId('mem', crypto.randomUUID()), t.clock.now())
    const outcome = await AgentCall.answer(deps, {
      organizationId: org,
      callId: call.id,
      providerCallId: call.providerCallId,
      sink,
    })
    expect(outcome.kind).toBe('not_answerable')
    expect(telephony.operations.map((operation) => operation.operation)).not.toContain(
      'playDisclosure'
    )
  })
})

describe('the speech loop', () => {
  test('replies in speech and stores the reply and its cost', async () => {
    const call = await live()
    t.llm.reply({ text: reply(), inputTokens: 100, outputTokens: 20 })
    tts.speak([AUDIO])
    tts.speak([AUDIO])
    const outcome = await say(call.id)
    expect(outcome).toEqual({ kind: 'replied', interrupted: false, ended: null })
    expect((await turnsOf(call.id)).map((turn) => [turn.index, turn.role])).toEqual([
      [0, 'prospect'],
      [1, 'agent'],
    ])
    expect((await turnsOf(call.id))[1]?.text).toBe(`${ONE} ${TWO}`)
    const chars = [...ONE].length + [...TWO].length
    const expected = 2 * 4000 + chars * 1500 + 100 * 30 + 20 * 150
    expect((await t.calls.get(org, call.id))?.agentCostMicroCents).toBe(expected)
  })

  test('barge-in cancels the speech and stores only what was spoken', async () => {
    const call = await live()
    t.llm.reply(reply())
    tts.speak([AUDIO])
    tts.speak([AUDIO, AUDIO, AUDIO])
    const cut = new AbortController()
    let heard = 0
    const outcome = await say(call.id, {
      bargeIn: cut.signal,
      sink: () => {
        heard += 1
        if (heard === 2) {
          cut.abort()
        }
      },
    })
    expect(outcome).toMatchObject({ kind: 'replied', interrupted: true })
    const agent = (await turnsOf(call.id))[1]
    expect(agent?.text).toBe(ONE)
    expect(agent?.text).not.toContain('unlimited')
    expect(tts.requests().at(-1)?.outcome).toBe('aborted')
    expect(tts.openStreams()).toBe(0)
  })

  test('the Agent keeps the Call going when it was cut off before its end_call was heard', async () => {
    const call = await live()
    t.llm.reply(reply({ toolCall: { name: 'end_call', arguments: {} } }))
    tts.speak([AUDIO, AUDIO])
    const cut = new AbortController()
    await say(call.id, { bargeIn: cut.signal, sink: () => cut.abort() })
    expect((await t.calls.get(org, call.id))?.state).toBe('live')
  })

  test('ends the Call at the duration cap, before the model is asked', async () => {
    const call = await live()
    t.clock.advance(`${DEFAULT_AGENT_SETTINGS.maxCallSeconds + 1}s`)
    const outcome = await say(call.id)
    expect(outcome).toEqual({ kind: 'ended', endReason: 'duration_cap' })
    expect(await t.calls.get(org, call.id)).toMatchObject({
      state: 'ended',
      endReason: 'duration_cap',
      endedBy: 'system',
    })
    expect(t.llm.requests()).toHaveLength(0)
    expect(telephony.operations.map((operation) => operation.operation)).toContain('hangUp')
  })

  test('ends the Call when an exchange reaches the cost cap', async () => {
    await settings({ maxCostUsdCents: 1 })
    const call = await live()
    t.llm.reply({ text: reply(), inputTokens: 40_000, outputTokens: 10 })
    tts.speak([AUDIO])
    tts.speak([AUDIO])
    const outcome = await say(call.id)
    expect(outcome).toMatchObject({ kind: 'replied', ended: 'cost_cap' })
    expect(await t.calls.get(org, call.id)).toMatchObject({ state: 'ended', endReason: 'cost_cap' })
  })

  test('does not ask the model again once the Call has already cost its cap', async () => {
    await settings({ maxCostUsdCents: 1 })
    const call = await live()
    t.calls.addAgentCost(org, call.id, 1_000_000)
    const outcome = await say(call.id)
    expect(outcome).toEqual({ kind: 'ended', endReason: 'cost_cap' })
    expect(t.llm.requests()).toHaveLength(0)
  })

  test('the end tool ends the Call politely after the goodbye was heard', async () => {
    const call = await live()
    t.llm.reply(
      reply({
        reply: 'Thanks for calling. Goodbye.',
        toolCall: { name: 'end_call', arguments: {} },
      })
    )
    tts.speak([AUDIO])
    tts.speak([AUDIO])
    const outcome = await say(call.id)
    expect(outcome).toEqual({ kind: 'replied', interrupted: false, ended: 'agent_ended' })
    expect(await t.calls.get(org, call.id)).toMatchObject({
      state: 'ended',
      endReason: 'agent_ended',
      failureReason: null,
    })
    expect((await turnsOf(call.id))[1]?.toolName).toBe('end_call')
  })
})

describe('a restart in the middle of a Call', () => {
  test('answers a Prospect turn that was stored but not answered at the same index, once', async () => {
    const call = await live()
    await t.turns.append(
      org,
      { kind: 'call', id: call.id },
      {
        index: 0,
        role: 'prospect',
        text: 'How much is the Team plan?',
        deferred: false,
        toolName: null,
        sources: [],
      }
    )
    t.llm.reply(reply())
    tts.speak([AUDIO])
    tts.speak([AUDIO])
    await say(call.id)
    expect((await turnsOf(call.id)).map((turn) => [turn.index, turn.role])).toEqual([
      [0, 'prospect'],
      [1, 'agent'],
    ])
  })

  test('carries on at the next index after the stored turns, without a duplicate or a double cost', async () => {
    const call = await live()
    for (let round = 0; round < 2; round += 1) {
      t.llm.reply({ text: reply(), inputTokens: 10, outputTokens: 10 })
      tts.speak([AUDIO])
      tts.speak([AUDIO])
      // A fresh adapter set over the same stores is what a restarted process has.
      deps = Object.assign(t, {
        tts: createMemoryTts({ sleep: async () => undefined, random: () => 0 }),
      })
      tts = deps.tts as MemoryTts
      tts.speak([AUDIO])
      tts.speak([AUDIO])
      await say(call.id)
    }
    expect((await turnsOf(call.id)).map((turn) => [turn.index, turn.role])).toEqual([
      [0, 'prospect'],
      [1, 'agent'],
      [2, 'prospect'],
      [3, 'agent'],
    ])
    const chars = [...ONE].length + [...TWO].length
    const one = 2 * 4000 + chars * 1500 + 10 * 30 + 10 * 150
    expect((await t.calls.get(org, call.id))?.agentCostMicroCents).toBe(2 * one)
  })
})

describe('Organizations', () => {
  test('another Organization can neither hear into nor answer a Call', async () => {
    const call = await live()
    const other = newOrganizationId()
    await settings()
    const before = await t.calls.get(org, call.id)
    expect(
      await AgentCall.hear(deps, {
        organizationId: other,
        callId: call.id,
        text: 'Hello?',
        audioSeconds: 1,
        sink,
      })
    ).toEqual({ kind: 'no_call' })
    expect(
      await AgentCall.answer(deps, {
        organizationId: other,
        callId: call.id,
        providerCallId: call.providerCallId,
        sink,
      })
    ).toEqual({ kind: 'not_answerable' })
    expect(t.llm.requests()).toHaveLength(0)
    expect(await turnsOf(call.id)).toEqual([])
    expect(await t.calls.get(org, call.id)).toEqual(before)
  })
})

describe('what the loop keeps out of logs', () => {
  test('no transcript or reply text is logged', async () => {
    const call = await live()
    t.llm.reply(reply())
    tts.speak([AUDIO])
    tts.speak([AUDIO])
    await say(call.id, { text: 'my secret question 12345' })
    expect(t.logLines.join('\n')).not.toContain('12345')
    expect(t.logLines.join('\n')).not.toContain('Team plan')
  })
})
