import { expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createMemoryTelephony, createMemoryTts } from 'tula-closeline-kit/testing'
import * as AgentCall from '../src/modules/agent-call/service'
import { DEFAULT_AGENT_SETTINGS } from '../src/modules/agent-settings/service'
import { createTestDeps, newOrganizationId } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// One Agent turn (`AgentCall.hear`) is the hot path of a live Agent Call: a Call read, the cap
// check, the conversation engine (idempotent Prospect insert, recent-turn read, evidence search,
// model call, validation, idempotent Agent insert with its atomic cost add) and one TTS stream per
// sentence. Each step is O(1) in the size of the Organization: keyed reads, a bounded window of
// recent turns, and keyed inserts. Model, speech and storage are memory adapters, so this gates our
// own code, not the vendors. Typical best batch: 46 ms for 500 turns (about 0.09 ms each; the memory
// stores scan the one Call's growing turn list, so later batches are slower). Budget: 5x, rounded.
const BUDGET_MS = 250

test(`agent turn: the best of ${BATCHES} batches of ${BATCH_REQUESTS} turns is within ${BUDGET_MS} ms`, async () => {
  const telephony = createMemoryTelephony()
  const tts = createMemoryTts({ sleep: async () => undefined, random: () => 0 })
  const t = createTestDeps({ telephony })
  const deps = Object.assign(t, { tts })
  const organizationId = newOrganizationId()
  await t.agentSettings.put(organizationId, {
    ...DEFAULT_AGENT_SETTINGS,
    hours: [...DEFAULT_AGENT_SETTINGS.hours],
    paused: false,
    // Caps high enough that a cap never ends the Call mid-run and flatters the number.
    maxCallSeconds: 3600,
    maxCostUsdCents: 100_000_000,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const callId = formatId('call', crypto.randomUUID())
  const providerCallId = telephony.receiveInbound(organizationId, '+14155550100', '+14155550199')
  await telephony.answerCall({
    organizationId,
    providerCallId,
    callId,
    ringIdentities: [formatId('mem', crypto.randomUUID())],
  })
  await t.calls.insertInbound(organizationId, {
    id: callId,
    lineId: formatId('line', crypto.randomUUID()),
    repMembershipId: null,
    callerNumber: '+14155550100',
    providerCallSid: providerCallId,
    createdAt: t.clock.now(),
  })
  const sink: AgentCall.AudioSink = () => undefined
  tts.speak([new Uint8Array([1])])
  tts.speak([new Uint8Array([1])])
  const answered = await AgentCall.answer(deps, {
    organizationId,
    callId,
    providerCallId,
    sink,
  })
  expect(answered.kind).toBe('live')

  let turn = 0
  const result = await measure(async () => {
    turn += 1
    t.llm.reply({
      text: JSON.stringify({ reply: 'Fine.', sources: [], deferred: true, toolCall: null }),
      inputTokens: 10,
      outputTokens: 5,
    })
    tts.speak([new Uint8Array([1])])
    const outcome = await AgentCall.hear(deps, {
      organizationId,
      callId,
      text: `question number ${turn}`,
      audioSeconds: 1,
      sink,
    })
    // A reply that did not happen (a cap, an error) would make the loop cheaper and hide a regression.
    if (outcome.kind !== 'replied') {
      throw new Error(`the Agent turn did not reply: ${outcome.kind}`)
    }
  })

  console.log(summary('agent-turn', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
