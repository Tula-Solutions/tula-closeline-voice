import type { Handoff, OrganizationId, VoiceCall } from 'tula-closeline-contract'
import { type LlmUsage, type TtsAudioChunk, TtsError, type TtsPort } from 'tula-closeline-kit'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import * as AgentTools from '~/modules/agent-tools/service'
import * as Calls from '~/modules/call/service'
import { AGENT_DISCLOSURE_WORDING } from '~/modules/call/service'
import * as Conversation from '~/modules/conversation/engine'
import * as Handoffs from '~/modules/handoff/service'
import { InvalidTransitionError, type StoredCall } from '~/ports/call-store'

/** What the speech loop needs from the container, plus the text-to-speech engine. */
export type AgentCallDeps = Calls.CallDeps &
  Conversation.ConversationDeps &
  AgentTools.AgentToolsDeps &
  Handoffs.HandoffDeps & {
    /** Turns the Agent's words into audio. */
    tts: TtsPort
  }

/** Where the Agent's audio goes: the media leg of the Call. Receives chunks in order. */
export type AudioSink = (chunk: TtsAudioChunk) => void

/** The longest all of one sentence's speech may take, in milliseconds. */
export const SENTENCE_TIMEOUT_MS = 15_000

/** The longest the Agent waits for the first audio of a sentence, in milliseconds. */
export const FIRST_AUDIO_TIMEOUT_MS = 3_000

/** The most characters of one sentence that are sent to be spoken. */
export const MAX_SENTENCE_CHARS = 1_000

const MICRO_CENTS_PER_USD_CENT = 1_000_000

/** The audio format of a phone call. */
const TELEPHONY_AUDIO = { encoding: 'pcm_mulaw', sampleRate: 8000 } as const

/** Splits a reply into sentences, so a Prospect who cuts in loses only the sentences not yet said. */
function sentencesOf(reply: string): string[] {
  return reply
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => [...sentence.trim()].slice(0, MAX_SENTENCE_CHARS).join(''))
    .filter((sentence) => sentence !== '')
}

type Spoken = { spoken: string; characters: number; interrupted: boolean }

/**
 * Speaks `text` sentence by sentence into `sink`. A sentence counts as spoken only once all its
 * audio was delivered; when `bargeIn` fires the open stream is cancelled and the rest is never
 * sent. A vendor failure ends the speech where it stood. Nothing here logs text or audio.
 */
export async function speakText(
  deps: AgentCallDeps,
  organizationId: string,
  voice: string,
  text: string,
  sink: AudioSink,
  bargeIn: AbortSignal | undefined
): Promise<Spoken> {
  const spoken: string[] = []
  let characters = 0
  for (const sentence of sentencesOf(text)) {
    if (bargeIn?.aborted) {
      return { spoken: spoken.join(' '), characters, interrupted: true }
    }
    const stream = deps.tts.open({
      organizationId: organizationId as Parameters<TtsPort['open']>[0]['organizationId'],
      voice,
      ...TELEPHONY_AUDIO,
      timeoutMs: SENTENCE_TIMEOUT_MS,
      firstChunkTimeoutMs: FIRST_AUDIO_TIMEOUT_MS,
      maxTextChars: MAX_SENTENCE_CHARS,
    })
    const cut = () => stream.cancel()
    bargeIn?.addEventListener('abort', cut, { once: true })
    try {
      stream.write(sentence)
      stream.finish()
      characters += [...sentence].length
      for await (const chunk of stream) {
        sink(chunk)
      }
    } catch (error) {
      if (!(error instanceof TtsError)) {
        throw error
      }
      deps.logger.warn('agent speech failed', { code: error.code })
      return { spoken: spoken.join(' '), characters, interrupted: false }
    } finally {
      bargeIn?.removeEventListener('abort', cut)
      await stream.close()
    }
    if (bargeIn?.aborted) {
      return { spoken: spoken.join(' '), characters, interrupted: true }
    }
    spoken.push(sentence)
  }
  return { spoken: spoken.join(' '), characters, interrupted: false }
}

/** What reaching for the Call produced. */
export type AnswerOutcome =
  | { kind: 'live'; call: StoredCall }
  | { kind: 'not_answerable' }
  | { kind: 'disclosure_failed' }
  | { kind: 'greeting_failed' }

/**
 * The Agent answers a ringing inbound Call nobody else holds. The Disclosure comes first: the Call
 * is claimed, the Disclosure plays, and only once the provider confirms it played and it is stored
 * does the Call move to `live` (the store refuses `live` for an Agent without an AI-saying
 * Disclosure). Only then are the greeting spoken and the model reachable. If the Disclosure is
 * late or fails, the Call fails with `disclosure_failed` and nothing else ever happens on it. The Recording starts before
 * `live`, as on a Rep's Call.
 */
export async function answer(
  deps: AgentCallDeps,
  input: {
    organizationId: string
    callId: VoiceCall['id']
    providerCallId: string
    sink: AudioSink
  }
): Promise<AnswerOutcome> {
  const { organizationId, callId, providerCallId } = input
  const claimed = await deps.calls.claimForAgent(organizationId, callId, deps.clock.now())
  if (claimed === undefined) {
    return { kind: 'not_answerable' }
  }
  const gone = await goLive(deps, organizationId, callId, providerCallId)
  if (gone.kind === 'failed') {
    return { kind: 'disclosure_failed' }
  }
  if (gone.kind === 'gone') {
    return { kind: 'not_answerable' }
  }
  const live = gone.call
  try {
    const settings = (await deps.agentSettings.get(organizationId)) ?? DEFAULT_AGENT_SETTINGS
    await speakText(
      deps,
      organizationId,
      settings.voiceStyle,
      settings.greeting,
      input.sink,
      undefined
    )
  } catch {
    // Nobody drives a live Call that cannot greet, and only a turn checks the caps: end it now.
    deps.logger.error('agent call greeting failed', { callId })
    await end(deps, organizationId, live, 'agent_ended')
    return { kind: 'greeting_failed' }
  }
  return { kind: 'live', call: live }
}

/** What taking a connecting Call live produced. */
export type GoLiveOutcome =
  | { kind: 'live'; call: StoredCall }
  | { kind: 'failed' }
  | { kind: 'gone' }

/**
 * Plays the Disclosure on a connecting Agent Call, starts the Recording and only then moves the
 * Call to `live` (the store refuses `live` for an Agent without an AI-saying Disclosure). A late
 * or failed Disclosure fails the Call and drops the line: nothing else ever happens on it.
 */
export async function goLive(
  deps: Calls.CallDeps,
  organizationId: string,
  callId: VoiceCall['id'],
  providerCallId: string
): Promise<GoLiveOutcome> {
  let live: StoredCall | undefined
  let played = false
  try {
    // This move is the claim: a duplicate delivery loses it and must not touch the Call.
    try {
      await deps.calls.transition(organizationId, callId, {
        to: 'disclosing',
        at: deps.clock.now(),
      })
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        return { kind: 'gone' }
      }
      throw error
    }
    const heard = await Calls.withinDeadline(deps, (options) =>
      deps.telephony.playDisclosure(
        {
          organizationId: organizationId as Parameters<
            typeof deps.telephony.playDisclosure
          >[0]['organizationId'],
          providerCallId,
          wordingVersion: AGENT_DISCLOSURE_WORDING.version,
          text: AGENT_DISCLOSURE_WORDING.text,
          aiAssisted: AGENT_DISCLOSURE_WORDING.aiAssisted,
        },
        options
      )
    )
    await deps.calls.recordDisclosure(organizationId, callId, {
      wordingVersion: heard.wordingVersion,
      aiAssisted: heard.aiAssisted,
      playedAt: new Date(heard.playedAt),
    })
    played = true
    await Calls.withinDeadline(deps, (options) =>
      deps.telephony.startRecording(
        {
          organizationId: organizationId as Parameters<
            typeof deps.telephony.startRecording
          >[0]['organizationId'],
          providerCallId,
        },
        options
      )
    )
    await deps.calls.recordRecordingStarted(organizationId, callId, deps.clock.now())
    live = await deps.calls.transition(organizationId, callId, {
      to: 'live',
      at: deps.clock.now(),
      agent: true,
    })
  } catch (error) {
    await fail(
      deps,
      organizationId,
      callId,
      providerCallId,
      played ? 'provider_error' : 'disclosure_failed'
    )
    deps.logger.warn('agent call disclosure failed', {
      callId,
      invalid: error instanceof InvalidTransitionError,
    })
    return { kind: 'failed' }
  }
  return live === undefined ? { kind: 'gone' } : { kind: 'live', call: live }
}

/** Fails a Call that did not reach `live`, and drops the line; best effort. */
async function fail(
  deps: Calls.CallDeps,
  organizationId: string,
  callId: VoiceCall['id'],
  providerCallId: string,
  failureReason: 'disclosure_failed' | 'provider_error'
): Promise<void> {
  await deps.calls
    .transition(organizationId, callId, {
      to: 'failed',
      at: deps.clock.now(),
      failureReason,
    })
    .catch(() => deps.logger.error('agent call fail unrecorded', { callId }))
  await Calls.withinDeadline(deps, (options) =>
    deps.telephony.hangUp(
      {
        organizationId: organizationId as Parameters<
          typeof deps.telephony.hangUp
        >[0]['organizationId'],
        providerCallId,
        by: 'system',
      },
      options
    )
  ).catch(() => deps.logger.warn('agent call hangup failed', { callId }))
}

/** Ends a live Call as `ended` with the stored reason and drops the line; best effort for the line. */
export async function end(
  deps: Calls.CallDeps,
  organizationId: string,
  call: StoredCall,
  endReason: NonNullable<VoiceCall['endReason']>
): Promise<void> {
  try {
    await deps.calls.transition(organizationId, call.id, {
      to: 'ended',
      at: deps.clock.now(),
      endedBy: 'system',
      endReason,
    })
  } catch (error) {
    // The Prospect or a Rep ended it first: nothing is left to end.
    if (error instanceof InvalidTransitionError) {
      return
    }
    throw error
  }
  if (call.providerCallSid !== null) {
    const providerCallId = call.providerCallSid
    await Calls.withinDeadline(deps, (options) =>
      deps.telephony.hangUp(
        {
          organizationId: organizationId as Parameters<
            typeof deps.telephony.hangUp
          >[0]['organizationId'],
          providerCallId,
          by: 'system',
        },
        options
      )
    ).catch(() => deps.logger.warn('agent call hangup failed', { callId: call.id }))
  }
  deps.logger.info('agent call ended', { callId: call.id, endReason })
}

/** Clamps a reported duration to a finite, non-negative number so it can never subtract or poison a cost. */
function safeSeconds(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

/** What the Agent costs for one exchange, in micro-cents, from the prices in the environment. */
function costOf(
  deps: AgentCallDeps,
  parts: { audioSeconds: number; characters: number; usage: LlmUsage }
): number {
  const { env } = deps
  return Math.ceil(
    safeSeconds(parts.audioSeconds) * env.STT_PRICE_MICRO_CENTS_PER_SECOND +
      parts.characters * env.TTS_PRICE_MICRO_CENTS_PER_CHARACTER +
      parts.usage.inputTokens * env.LLM_INPUT_PRICE_MICRO_CENTS_PER_TOKEN +
      parts.usage.outputTokens * env.LLM_OUTPUT_PRICE_MICRO_CENTS_PER_TOKEN
  )
}

/** The next free Prospect turn index of a Call, from what is stored, so a restart picks up in place. */
export async function nextProspectIndex(
  deps: AgentCallDeps,
  organizationId: string,
  callId: string
): Promise<number> {
  const [last] = await deps.turns.recent(
    organizationId,
    { kind: 'call', id: callId },
    MAX_TURN_INDEX,
    1
  )
  if (last === undefined) {
    return 0
  }
  // An Agent turn closes its exchange; a lone Prospect turn is answered again, at its own index.
  return last.role === 'agent' ? last.index + 1 : last.index
}

/** The highest turn index looked at; far above any Call the duration and cost caps allow. */
const MAX_TURN_INDEX = 2_000_000_000

/** What hearing the Prospect produced. */
export type HearOutcome =
  | { kind: 'no_call' }
  | { kind: 'not_live' }
  | { kind: 'replied'; interrupted: boolean; ended: NonNullable<VoiceCall['endReason']> | null }
  | { kind: 'ended'; endReason: NonNullable<VoiceCall['endReason']> }
  | { kind: 'handed_off' }

/**
 * Handles one settled Prospect turn of a live Agent Call: checks the caps before the model is
 * asked, has the engine reply, speaks the reply into `sink` (cancelled the moment `bargeIn`
 * fires), stores only the words that were heard, adds the exchange's cost to the Call in the same
 * step, and then ends the Call when the cost cap is reached or the Agent asked to end it. Turns
 * must be fed one at a time. Another Organization's Call is `no_call`.
 */
export async function hear(
  deps: AgentCallDeps,
  input: {
    organizationId: string
    callId: VoiceCall['id']
    text: string
    /** Seconds of Prospect audio this turn spans, for the speech-to-text cost. */
    audioSeconds: number
    sink: AudioSink
    bargeIn?: AbortSignal
  }
): Promise<HearOutcome> {
  const { organizationId, callId } = input
  const call = await deps.calls.get(organizationId, callId)
  if (call === undefined) {
    return { kind: 'no_call' }
  }
  if (call.state !== 'live') {
    return { kind: 'not_live' }
  }
  if (call.repMembershipId !== null) {
    return { kind: 'handed_off' }
  }
  const settings = (await deps.agentSettings.get(organizationId)) ?? DEFAULT_AGENT_SETTINGS
  const capped = capReached(deps, call, settings)
  if (capped !== null) {
    await end(deps, organizationId, call, capped)
    return { kind: 'ended', endReason: capped }
  }

  let characters = 0
  let interrupted = false
  let wholeReplySpoken = false
  const turnIndex = await nextProspectIndex(deps, organizationId, callId)
  const scope = { organizationId, callId, turnIndex }
  const result = await Conversation.converse(
    deps,
    {
      organizationId,
      conversation: { kind: 'call', id: callId },
      turnIndex,
      text: input.text,
    },
    {
      tools: {
        context: () => AgentTools.contextFor(deps, scope),
        act: (toolCall) => AgentTools.run(deps, scope, toolCall),
      },
      speak: async ({ reply, usage }) => {
        const said = await speakText(
          deps,
          organizationId,
          settings.voiceStyle,
          reply,
          input.sink,
          input.bargeIn
        )
        characters = said.characters
        interrupted = said.interrupted
        wholeReplySpoken = !said.interrupted && sentencesOf(reply).join(' ') === said.spoken
        return {
          spoken: said.spoken,
          costMicroCents: costOf(deps, { audioSeconds: input.audioSeconds, characters, usage }),
        }
      },
    }
  )

  // A replayed exchange was already answered, and its tool call is not run twice.
  const after =
    result.toolCall?.name === 'end_call' && wholeReplySpoken
      ? 'agent_ended'
      : (result.callCostMicroCents ?? 0) >= settings.maxCostUsdCents * MICRO_CENTS_PER_USD_CENT
        ? 'cost_cap'
        : capReached(deps, call, settings)
  if (after !== null) {
    await end(deps, organizationId, call, after)
    return { kind: 'replied', interrupted, ended: after }
  }
  const reason: Handoff['reason'] | null =
    result.toolCall?.name === 'hand_off'
      ? result.toolCall.arguments.reason
      : result.deferred
        ? 'agent_unsure'
        : null
  if (reason !== null) {
    const handoff = await Handoffs.start(deps, {
      organizationId: organizationId as OrganizationId,
      callId,
      reason,
    })
    if (handoff.kind === 'bridged') {
      return { kind: 'handed_off' }
    }
    if (handoff.kind === 'booking_offered') {
      await speakText(
        deps,
        organizationId,
        settings.voiceStyle,
        NO_REP_REPLY,
        input.sink,
        input.bargeIn
      )
    }
  }
  return { kind: 'replied', interrupted, ended: null }
}

/** Said when no Rep could take the Call; the Agent's own booking tools take it from there. */
const NO_REP_REPLY =
  'I cannot reach anyone from the team right now. I can book a time with them instead. Would you like me to find a time?'

/** The cap the Call has reached, if any: its length or what the Agent has cost. */
function capReached(
  deps: AgentCallDeps,
  call: StoredCall,
  settings: { maxCallSeconds: number; maxCostUsdCents: number }
): 'duration_cap' | 'cost_cap' | null {
  const answeredAt = call.answeredAt === null ? undefined : Date.parse(call.answeredAt)
  if (
    answeredAt !== undefined &&
    deps.clock.now().getTime() - answeredAt >= settings.maxCallSeconds * 1000
  ) {
    return 'duration_cap'
  }
  return call.agentCostMicroCents >= settings.maxCostUsdCents * MICRO_CENTS_PER_USD_CENT
    ? 'cost_cap'
    : null
}
