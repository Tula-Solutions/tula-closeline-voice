import {
  type AgentCall,
  type CallGateCode,
  formatId,
  type OrganizationId,
  type VoiceCall,
  type VoiceCallFailureReason,
} from 'tula-closeline-contract'
import {
  type AnsweredBy,
  MAX_DETECTION_WINDOW_MS,
  TelephonyError,
  type TelephonyEventType,
} from 'tula-closeline-kit'
import type { Container } from '~/container'
import type { AgentCallDeps, AudioSink } from '~/modules/agent-call/service'
import * as AgentCalls from '~/modules/agent-call/service'
import {
  type AgentCallRequestDeps,
  lineCapDecision,
  recheck,
} from '~/modules/agent-call-request/service'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import * as Calls from '~/modules/call/service'
import { phoneHash } from '~/modules/recording/finish'
import { eventRegistry } from '~/modules/recording/messages'
import { mediaBase } from '~/modules/transcript/service'
import type { AgentCallOpening, Settlement, StoredAgentCall } from '~/ports/agent-call-store'
import { InvalidTransitionError, type StoredCall } from '~/ports/call-store'

/** What the dialer needs from the container: the gate's deps, the speech loop's and the event queue. */
export type DialDeps = AgentCallRequestDeps &
  Omit<AgentCallDeps, 'tts'> &
  Pick<Container, 'events' | 'agentAudio'>

/** What a dial attempt came to. */
export type DialOutcome =
  | { kind: 'dialing'; agentCallId: string; callId: string }
  | { kind: 'deferred'; retryAt: Date }
  | { kind: 'blocked'; code: CallGateCode }
  | { kind: 'failed' }
  | { kind: 'gone' }

/** How long after it went live a late `machine` verdict still ends the Call as a voicemail. */
export const LATE_MACHINE_WINDOW_MS = 10_000

/** The cap on a stored duration, which the event contract enforces too. */
const MAX_DURATION_SECONDS = 1_800

const DAY_MS = 86_400_000

/** The Agent's opening when no Organization name and goal were kept with the request. */
export const OPENING_WORDING =
  'I am calling on behalf of the team you recently heard from, with a short follow-up. Is now a good time to talk?'

/**
 * The Agent's opening, said after the Disclosure: who it calls for, why, and whether now suits.
 * It names the Organization and the Step's goal when they were stored at request time.
 */
export function openingWording(opening: AgentCallOpening | undefined): string {
  const who = opening?.organizationName ?? null
  const goal = opening?.goal?.trim().replace(/[.!?\s]+$/, '') ?? ''
  if (who === null && goal === '') {
    return OPENING_WORDING
  }
  const from = who === null ? 'the team you recently heard from' : who
  const why = goal === '' ? 'a short follow-up' : `the reason for my call: ${goal}`
  return `I am calling on behalf of ${from}, with ${why}. Is now a good time to talk?`
}

/** Said when the Prospect says it is not a good time, just before the Call ends. */
export const NOT_NOW_FAREWELL = 'No problem. We will try you another time. Goodbye.'

const NOT_NOW =
  /\b(not now|not a good time|bad time|busy right now|call (me )?back|call (me )?later|another time|can't talk|cannot talk)\b/i

/** The voice Call id an Agent Call dials under: the same on every retry, so a retry finds its Call. */
export const callIdOf = (agentCallId: string): VoiceCall['id'] =>
  formatId('call', agentCallId.replace(/^acl_/, ''))

/** The id of an Agent Call's one `voice.agent_call.ended` event: the same on every delivery. */
export const endedEventIdOf = (agentCallId: string): string =>
  `evt_${new Bun.CryptoHasher('sha256').update(`voice.agent_call.ended:${agentCallId}`).digest('hex').slice(0, 32)}`

/**
 * The media stream URL the provider connects the call's audio to; the Organization is in the path.
 * The `/talk` form is the stream after the Disclosure, the only one the Agent hears and speaks on.
 */
export function streamUrlOf(
  deps: Pick<DialDeps, 'env'>,
  organizationId: string,
  callId: string,
  talk = false
) {
  const base = mediaBase(deps.env).replace(/^http/, 'ws')
  return `${base}/media/agent-calls/${organizationId}/${callId}${talk ? '/talk' : ''}`
}

const settlementOf = (code: CallGateCode, at: Date): Settlement => ({
  kind: 'blocked',
  gateCode: code,
  at,
})

/** What ending a dialed Agent Call needs; the stale sweep passes the same four. */
export type EndDeps = Pick<DialDeps, 'agentCalls' | 'calls' | 'clock' | 'events'>

/** Publishes the ended event for a row that just ended. Safe to repeat: the event id is stable. */
async function publishEnded(
  deps: EndDeps,
  organizationId: string,
  row: StoredAgentCall,
  call: StoredCall | undefined
): Promise<void> {
  if (row.result === null || row.endedAt === null) {
    return
  }
  const answered = call?.answeredAt != null
  const seconds =
    call !== undefined && answered && call.endedAt !== null
      ? Math.round((Date.parse(call.endedAt) - Date.parse(call.answeredAt as string)) / 1000)
      : null
  await deps.events.publish(
    eventRegistry.create({
      type: 'voice.agent_call.ended',
      id: endedEventIdOf(row.id),
      traceId: call?.id ?? row.id,
      organizationId,
      occurredAt: new Date(row.endedAt),
      payload: {
        agentCallId: row.id,
        callId: row.callId,
        source: row.source,
        enrollmentId: row.enrollmentId,
        stepKey: row.stepKey,
        prospectId: row.prospectId,
        attempt: row.attempt,
        result: row.result,
        endReason: row.endReason,
        gateCode: row.gateCode,
        durationSeconds:
          row.durationSeconds ??
          (seconds === null ? null : Math.min(MAX_DURATION_SECONDS, Math.max(0, seconds))),
        disclosureWordingVersion:
          row.callId === null ? null : (call?.disclosure.wordingVersion ?? null),
        endedAt: row.endedAt,
      },
    })
  )
}

/**
 * Ends a dialed Agent Call once with `result`, and publishes `voice.agent_call.ended`. The store
 * answers `undefined` to a replay, so a repeated callback neither changes the row nor publishes.
 */
async function conclude(
  deps: EndDeps,
  organizationId: string,
  agentCallId: string,
  result: NonNullable<AgentCall['result']>,
  endReason: AgentCall['endReason']
): Promise<void> {
  const row = await deps.agentCalls.get(organizationId, agentCallId)
  if (row === undefined || row.callId === null) {
    return
  }
  const call = await deps.calls.get(organizationId, row.callId)
  const at = deps.clock.now()
  const seconds =
    call?.answeredAt != null
      ? Math.min(
          MAX_DURATION_SECONDS,
          Math.max(0, Math.round((at.getTime() - Date.parse(call.answeredAt)) / 1000))
        )
      : null
  const finished = await deps.agentCalls.finish(organizationId, agentCallId, {
    result,
    endReason,
    durationSeconds: seconds,
    at,
  })
  if (finished !== undefined) {
    await publishEnded(deps, organizationId, finished, call)
  }
}

/**
 * Ends the Agent Call of an outbound Call the stale sweep just failed, so it stops counting
 * against its Line's concurrent cap. A Call that is not an Agent Call, or an Agent Call that
 * already ended, changes nothing. shortcut: a `dialing` row with no voice Call at all (a crash
 * between the claim and the Call insert) is not reaped; it needs a cross-Organization scan in
 * `tula-closeline-db`.
 */
export async function reapFailedCall(
  deps: EndDeps,
  organizationId: string,
  call: StoredCall
): Promise<void> {
  const row = await deps.agentCalls.byCallId(organizationId, call.id)
  if (row !== undefined) {
    await conclude(
      deps,
      organizationId,
      row.id,
      call.failureReason === 'no_answer' ? 'no_answer' : 'failed',
      null
    )
  }
}

/** Fails a Call that was never answered and stores the matching result on the Agent Call. */
async function failDial(
  deps: DialDeps,
  organizationId: string,
  agentCallId: string,
  callId: VoiceCall['id'],
  reason: VoiceCallFailureReason,
  result: 'no_answer' | 'busy' | 'failed'
): Promise<void> {
  try {
    await deps.calls.transition(organizationId, callId, {
      to: 'failed',
      at: deps.clock.now(),
      failureReason: reason,
    })
  } catch (error) {
    if (!(error instanceof InvalidTransitionError)) {
      throw error
    }
  }
  await conclude(deps, organizationId, agentCallId, result, null)
}

/** Settles a gate refusal that came after the request, and tells consumers the Step's call is over. */
async function refuse(
  deps: DialDeps,
  organizationId: OrganizationId,
  agentCallId: string
): Promise<DialOutcome> {
  const row = await deps.agentCalls.get(organizationId, agentCallId)
  if (row?.result === 'blocked' && row.gateCode !== null) {
    await publishEnded(deps, organizationId, row, undefined)
    return { kind: 'blocked', code: row.gateCode }
  }
  if (row?.retryAt != null && row.gateCode !== null) {
    return { kind: 'deferred', retryAt: new Date(row.retryAt) }
  }
  return { kind: 'gone' }
}

/**
 * Dials a queued Agent Call (or finishes the dial of one a crash left `dialing`). The gate runs
 * again, then the claim re-checks the Line caps and the Contact Check with the Line held and stamps
 * `dialedAt`; only then is the Call created and the provider asked, under a key that is the Agent
 * Call's id, so a retry after a crash dials once. Another Organization's row is `gone`.
 */
export async function dial(
  deps: DialDeps,
  organizationId: OrganizationId,
  agentCallId: string
): Promise<DialOutcome> {
  let row = await deps.agentCalls.get(organizationId, agentCallId)
  if (row === undefined || row.lineId === null) {
    return { kind: 'gone' }
  }
  const callId = callIdOf(row.id)
  const prospect = await deps.prospects.lookup(organizationId, row.prospectId)
  if (prospect?.phone == null) {
    return { kind: 'gone' }
  }
  const phone = prospect.phone
  const prospectId = row.prospectId

  if (row.state === 'queued') {
    const decision = await recheck(deps, organizationId, agentCallId)
    if (decision === undefined) {
      return { kind: 'gone' }
    }
    if (decision.kind !== 'allow') {
      return refuse(deps, organizationId, agentCallId)
    }
    const now = deps.clock.now()
    const claim = await deps.agentCalls.claimDial(organizationId, agentCallId, {
      at: now,
      numberHash: Buffer.from(
        phoneHash(deps.env.PHONE_HASH_KEY ?? '', organizationId, phone),
        'hex'
      ),
      callId,
      since: new Date(now.getTime() - DAY_MS),
      contactCheck: async () => {
        // The Line row is locked while this runs, so a stalled guard must not hold it: fail closed.
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), deps.numberTimeoutMs)
        })
        const check = await Promise.race([
          deps.contactGuard
            .check({
              organizationId,
              prospectId,
              phone,
              channel: 'phone',
              purpose: 'agent_initiated',
            })
            .catch(() => undefined),
          deadline,
        ]).finally(() => clearTimeout(timer))
        if (check === undefined) {
          return settlementOf('consent.unavailable', now)
        }
        return check.allowed ? undefined : settlementOf(check.code, now)
      },
    })
    if (claim.kind === 'gone') {
      return { kind: 'gone' }
    }
    if (claim.kind === 'capped') {
      const capped = lineCapDecision(claim.usage, now)
      if (capped.kind === 'deferred') {
        await deps.agentCalls.settle(organizationId, agentCallId, {
          kind: 'deferred',
          gateCode: capped.code,
          retryAt: capped.retryAt,
        })
      }
      return refuse(deps, organizationId, agentCallId)
    }
    if (claim.kind === 'refused') {
      await deps.agentCalls.settle(organizationId, agentCallId, claim.settlement)
      return refuse(deps, organizationId, agentCallId)
    }
    row = claim.call
  } else if (row.state !== 'dialing') {
    return { kind: 'gone' }
  }

  const lineId = row.lineId
  if (lineId === null) {
    return { kind: 'gone' }
  }
  const line = await deps.lines.get(organizationId, lineId)
  if (line === undefined) {
    return { kind: 'gone' }
  }
  const { call } = await deps.calls.insertAgentOutbound(organizationId, {
    id: callId,
    lineId,
    prospectId: row.prospectId,
    prospectNumber: phone,
    createdAt: deps.clock.now(),
  })
  if (call.state !== 'ringing' || call.providerCallSid !== null) {
    return { kind: 'dialing', agentCallId, callId }
  }
  try {
    const placed = await Calls.withinDeadline(deps, (options) =>
      deps.telephony.placeAgentCall(
        {
          organizationId,
          callId,
          idempotencyKey: agentCallId,
          from: line.number,
          to: phone,
          streamUrl: streamUrlOf(deps, organizationId, callId),
          detectionWindowMs: MAX_DETECTION_WINDOW_MS,
        },
        options
      )
    )
    await deps.calls.setProviderCallSid(organizationId, callId, placed.providerCallId)
  } catch (error) {
    deps.logger.warn('agent call dial failed', {
      callId,
      code: error instanceof TelephonyError ? error.code : 'unknown',
    })
    await failDial(deps, organizationId, agentCallId, callId, Calls.reasonOf(error), 'failed')
    return { kind: 'failed' }
  }
  return { kind: 'dialing', agentCallId, callId }
}

/** What the provider reported about a dialed Call. */
export type DialEvent = {
  organizationId: OrganizationId
  callId: VoiceCall['id']
  providerCallId: string
  type: TelephonyEventType
  /** Who answered, for a `detection` event. */
  answeredBy?: AnsweredBy
}

/** Moves a ringing Call to `connecting`; a repeat or a later state is left alone. */
async function connecting(
  deps: DialDeps,
  organizationId: string,
  callId: VoiceCall['id']
): Promise<void> {
  await deps.calls
    .transition(organizationId, callId, { to: 'connecting', at: deps.clock.now() })
    .catch((error: unknown) => {
      if (!(error instanceof InvalidTransitionError)) {
        throw error
      }
    })
}

/** Drops the line without a word. Best effort: the Call is already recorded as over. */
async function dropSilently(
  deps: DialDeps,
  organizationId: OrganizationId,
  providerCallId: string,
  callId: string
): Promise<void> {
  await Calls.withinDeadline(deps, (options) =>
    deps.telephony.hangUp({ organizationId, providerCallId, by: 'system' }, options)
  ).catch(() => deps.logger.warn('agent call hangup failed', { callId }))
}

/** A machine answered: nothing is said or asked of the model, and the Call is a voicemail. */
async function voicemail(
  deps: DialDeps,
  event: DialEvent,
  call: StoredCall,
  row: StoredAgentCall
): Promise<void> {
  const { organizationId } = event
  if (call.state === 'live') {
    await AgentCalls.end(deps, organizationId, call, 'agent_ended')
  } else {
    await deps.calls
      .transition(organizationId, call.id, { to: 'missed', at: deps.clock.now() })
      .catch((error: unknown) => {
        if (!(error instanceof InvalidTransitionError)) {
          throw error
        }
      })
    await dropSilently(deps, organizationId, event.providerCallId, call.id)
  }
  await conclude(deps, organizationId, row.id, 'voicemail', null)
}

/** A human, or an unknown answerer, picked up: the Disclosure plays first; the opening waits for the stream. */
async function greet(
  deps: DialDeps,
  event: DialEvent,
  call: StoredCall,
  row: StoredAgentCall
): Promise<void> {
  const { organizationId } = event
  if (call.state === 'ringing') {
    await connecting(deps, organizationId, call.id)
  }
  const outcome = await AgentCalls.goLive(
    deps,
    organizationId,
    call.id,
    event.providerCallId,
    streamUrlOf(deps, organizationId, call.id, true)
  )
  if (outcome.kind === 'failed') {
    await conclude(deps, organizationId, row.id, 'failed', null)
    return
  }
  if (outcome.kind === 'gone') {
    return
  }
  await deps.agentCalls.markLive(organizationId, row.id)
}

/**
 * Speaks the opening once the Call is live and its media stream is up (the stream calls this).
 * When nothing can be said (no voice engine, or it failed) the Call ends rather than sit silent.
 */
export async function open(
  deps: DialDeps,
  input: { organizationId: OrganizationId; callId: VoiceCall['id']; bargeIn?: AbortSignal }
): Promise<{ spoken: boolean }> {
  const { organizationId, callId } = input
  const row = await deps.agentCalls.byCallId(organizationId, callId)
  const call = await deps.calls.get(organizationId, callId)
  const audio = deps.agentAudio
  if (row === undefined || call?.state !== 'live') {
    return { spoken: false }
  }
  const spoken =
    audio === undefined
      ? ''
      : (
          await AgentCalls.speakText(
            { ...deps, tts: audio.tts },
            organizationId,
            ((await deps.agentSettings.get(organizationId)) ?? DEFAULT_AGENT_SETTINGS).voiceStyle,
            openingWording(await deps.agentCalls.opening(organizationId, row.id)),
            audio.sinkFor(callId),
            input.bargeIn
          )
        ).spoken
  if (spoken === '' && input.bargeIn?.aborted !== true) {
    await AgentCalls.end(deps, organizationId, call, 'agent_ended')
    await conclude(deps, organizationId, row.id, 'answered', 'agent_ended')
  }
  return { spoken: spoken !== '' }
}

/**
 * Applies one provider report to a dialed Agent Call. `answered` only moves the Call on: the Agent
 * stays silent until the detection verdict arrives (at most the detection window). `machine` ends
 * it silently as a voicemail, `human` and `unknown` start the Disclosure, and a late `machine`
 * within the first {@link LATE_MACHINE_WINDOW_MS} of a live Call ends it the same way. Every branch
 * is safe to run twice. A Call that is not an Agent's is left alone.
 */
export async function onEvent(deps: DialDeps, event: DialEvent): Promise<void> {
  const { organizationId } = event
  const call = await deps.calls.get(organizationId, event.callId)
  if (call === undefined || call.direction !== 'outbound' || call.repMembershipId !== null) {
    return
  }
  const row = await deps.agentCalls.byCallId(organizationId, call.id)
  if (row === undefined) {
    return
  }
  if (call.providerCallSid === null) {
    await deps.calls.setProviderCallSid(organizationId, call.id, event.providerCallId)
  }
  if (event.type === 'answered') {
    if (call.state === 'ringing') {
      await connecting(deps, organizationId, call.id)
    }
    return
  }
  if (event.type === 'detection') {
    const verdict = event.answeredBy ?? 'unknown'
    if (call.state === 'ringing' || call.state === 'connecting') {
      await (verdict === 'machine' ? voicemail : greet)(deps, event, call, row)
    } else if (call.state === 'live' && verdict === 'machine') {
      const liveFor = deps.clock.now().getTime() - Date.parse(call.answeredAt ?? call.createdAt)
      if (liveFor <= LATE_MACHINE_WINDOW_MS) {
        await voicemail(deps, event, call, row)
      }
    }
    return
  }
  const unanswered: Partial<
    Record<TelephonyEventType, [VoiceCallFailureReason, 'no_answer' | 'busy' | 'failed']>
  > = {
    no_answer: ['no_answer', 'no_answer'],
    busy: ['busy', 'busy'],
    failed: ['provider_error', 'failed'],
  }
  const failure = unanswered[event.type]
  if (failure !== undefined && (call.state === 'ringing' || call.state === 'connecting')) {
    await failDial(deps, organizationId, row.id, call.id, failure[0], failure[1])
    return
  }
  if (event.type === 'completed') {
    if (call.state === 'live') {
      await deps.calls
        .transition(organizationId, call.id, {
          to: 'ended',
          at: deps.clock.now(),
          endedBy: 'prospect',
          endReason: 'prospect_hung_up',
        })
        .catch((error: unknown) => {
          if (!(error instanceof InvalidTransitionError)) {
            throw error
          }
        })
      await conclude(deps, organizationId, row.id, 'answered', 'prospect_hung_up')
    } else if (call.state === 'ringing' || call.state === 'connecting') {
      await failDial(deps, organizationId, row.id, call.id, 'carrier_dropped', 'no_answer')
    }
  }
}

/** What one Prospect turn of a dialed Agent Call produced. */
export type TurnOutcome = AgentCalls.HearOutcome | { kind: 'not_agent_call' }

/**
 * Handles one settled Prospect turn. The first turn is checked for "not now" (the opening asked):
 * the Agent says goodbye and the Call ends as `not_now`. Everything else is the speech loop, and
 * an ended loop stores the Agent Call's result. Turns must be fed one at a time.
 * shortcut: "not now" is a small word list, not the stop-phrase matcher (another ticket owns that).
 */
export async function turn(
  deps: DialDeps,
  input: {
    organizationId: OrganizationId
    callId: VoiceCall['id']
    text: string
    audioSeconds: number
    bargeIn?: AbortSignal
  }
): Promise<TurnOutcome> {
  const { organizationId, callId } = input
  const row = await deps.agentCalls.byCallId(organizationId, callId)
  const audio = deps.agentAudio
  if (row === undefined || audio === undefined) {
    return { kind: 'not_agent_call' }
  }
  const full: AgentCallDeps = { ...deps, tts: audio.tts }
  const sink: AudioSink = audio.sinkFor(callId)
  if (
    NOT_NOW.test(input.text) &&
    (await AgentCalls.nextProspectIndex(full, organizationId, callId)) === 0
  ) {
    const call = await deps.calls.get(organizationId, callId)
    if (call?.state !== 'live') {
      return { kind: 'not_live' }
    }
    const settings = (await deps.agentSettings.get(organizationId)) ?? DEFAULT_AGENT_SETTINGS
    await AgentCalls.speakText(
      full,
      organizationId,
      settings.voiceStyle,
      NOT_NOW_FAREWELL,
      sink,
      undefined
    )
    await AgentCalls.end(full, organizationId, call, 'agent_ended')
    await conclude(deps, organizationId, row.id, 'answered', 'not_now')
    return { kind: 'ended', endReason: 'agent_ended' }
  }
  const outcome = await AgentCalls.hear(full, { ...input, sink })
  const ended =
    outcome.kind === 'ended' ? outcome.endReason : outcome.kind === 'replied' ? outcome.ended : null
  if (ended !== null) {
    await conclude(
      deps,
      organizationId,
      row.id,
      'answered',
      ended === 'duration_cap' || ended === 'cost_cap' ? 'cap_reached' : 'agent_ended'
    )
  } else if (outcome.kind === 'handed_off') {
    await conclude(deps, organizationId, row.id, 'answered', 'handed_off')
  }
  return outcome
}
