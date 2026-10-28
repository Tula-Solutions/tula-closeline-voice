import {
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type ListVoiceCallsQuery,
  type PlaceCallRequest,
  type PlacedCall,
  placedCallSchema,
  type Role,
  SALES_HISTORY_ERRORS,
  VOICE_ADMIN_ROLES,
  VOICE_ALL_ROLES,
  VOICE_ERRORS,
  type VoiceCall,
  type VoiceCallFailureReason,
  voiceCallCursorSchema,
  type WrapUpRequest,
} from 'tula-closeline-contract'
import { TELEPHONY_ERROR_CODES, TelephonyError, type TelephonyEventType } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent, requestHash } from '~/modules/idempotency/service'
import * as Transcript from '~/modules/transcript/service'
import { InvalidTransitionError, type StoredCall } from '~/ports/call-store'
import type { StoredLine } from '~/ports/line-store'

/** What the Call service needs from the container. */
export type CallDeps = Pick<
  Container,
  | 'calls'
  | 'recordings'
  | 'callTurns'
  | 'transcribe'
  | 'copilot'
  | 'lines'
  | 'telephony'
  | 'directory'
  | 'clock'
  | 'logger'
  | 'idempotency'
  | 'numberTimeoutMs'
  | 'env'
>

/** The route name a place-Call `Idempotency-Key` is stored under. */
export const PLACE_CALL_ROUTE = 'calls.place'

/**
 * The Disclosure played to the Prospect on every Call a Rep places, in force from version 1. It
 * says the Call is recorded and nothing about an AI, because no AI takes part in a Rep's Call.
 * There is no setting that skips, shortens or replaces it (ADR 0003). Changing the words means a
 * new version number, since each Call stores the version that played.
 */
export const DISCLOSURE_WORDING = {
  version: 1,
  aiAssisted: false,
  text: 'Hello. This call is being recorded for quality and training purposes. By staying on the line you agree to the recording.',
} as const

/**
 * The Disclosure played first on every Call the Agent answers, in force from version 2. It says an
 * AI is speaking and that the Call is recorded. The Call can reach `live` only after this wording
 * (or any wording with `aiAssisted`) has played, and no setting skips or replaces it (ADR 0003).
 */
export const AGENT_DISCLOSURE_WORDING = {
  version: 2,
  aiAssisted: true,
  text: 'Hello. You are speaking with an AI assistant, and this call is being recorded for quality and training purposes. By staying on the line you agree to the recording.',
} as const

/**
 * The Disclosure played first on a Rep's Call with the Copilot on, in force from version 3. It
 * tells the Prospect an AI assistant is helping the Rep and that the Call is recorded. Speech
 * goes to speech-to-text only after it has played (ADR 0003); no setting skips or replaces it.
 */
export const COPILOT_DISCLOSURE_WORDING = {
  version: 3,
  aiAssisted: true,
  text: 'Hello. This call is being recorded, and an AI assistant is helping the sales representative on this call, for quality and training purposes. By staying on the line you agree to the recording.',
} as const

/**
 * The Disclosure played before a Rep is bridged onto an Agent Call (a warm Handoff), in force from
 * version 4. It says a person is joining and that the Call is recorded and AI-assisted. It plays
 * before the bridge and no setting skips or replaces it (ADR 0003).
 */
export const HANDOFF_DISCLOSURE_WORDING = {
  version: 4,
  aiAssisted: true,
  text: 'One moment. I am connecting you with a sales representative. This call is being recorded, and an AI assistant is helping on this call, for quality and training purposes. By staying on the line you agree to the recording.',
} as const

/**
 * Extra time the Disclosure step gets on top of the provider deadline: the provider waits for the
 * words to be spoken (up to about 18 s for the longest wording), which the plain deadline cannot hold.
 */
export const DISCLOSURE_SPEECH_ALLOWANCE_MS = 20_000

const E164 = /^\+[1-9][0-9]{6,14}$/

/** The most Calls a page of the list may hold, one more than the page is read to find the next. */
const PAGE_PROBE = 1

/**
 * Turns what a Rep typed into E.164. Spaces, brackets, dots and dashes are dropped from a number
 * that starts with `+`; a number without a country code, or one the pattern refuses, is
 * `call.number_invalid`: guessing a country would dial the wrong Prospect.
 */
export function normaliseNumber(raw: string): string {
  const trimmed = raw.trim()
  const digits = trimmed.startsWith('+') ? trimmed.replace(/[ ().-]/g, '') : trimmed
  if (!E164.test(digits)) {
    throw domainError(VOICE_ERRORS['call.number_invalid'])
  }
  return digits
}

const isAdmin = (caller: Caller): boolean =>
  (VOICE_ADMIN_ROLES as readonly Role[]).includes(caller.role)

function requireVoiceRole(caller: Caller): void {
  if (!(VOICE_ALL_ROLES as readonly Role[]).includes(caller.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
}

/** Drops what is internal to the service (the provider's id) before a Call leaves it. */
function toCall(stored: StoredCall): VoiceCall {
  const {
    providerCallSid: _providerCallSid,
    agentCostMicroCents: _cost,
    copilot: _copilot,
    ...call
  } = stored
  return call
}

/** Runs one provider call under the deadline; a call that outlives it is `telephony.unavailable`. */
export async function withinDeadline<T>(
  deps: CallDeps,
  call: (options: { timeoutMs: number }) => Promise<T>,
  timeoutMs = deps.numberTimeoutMs
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TelephonyError(TELEPHONY_ERROR_CODES.unavailable, 'timed out')),
      timeoutMs
    )
  })
  const running = call({ timeoutMs })
  running.catch(() => undefined)
  try {
    return await Promise.race([running, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Why a provider failure ended the Call, as the contract names it. */
function reasonOf(error: unknown): VoiceCallFailureReason {
  if (error instanceof TelephonyError) {
    if (error.code === TELEPHONY_ERROR_CODES.unavailable) {
      return 'timeout'
    }
    if (error.code === TELEPHONY_ERROR_CODES.rejected) {
      return 'carrier_rejected'
    }
  }
  return 'provider_error'
}

/** Which Reps' Calls the caller may see: `undefined` for all, otherwise the Memberships. */
async function visibleReps(deps: CallDeps, caller: Caller): Promise<string[] | undefined> {
  requireVoiceRole(caller)
  if (isAdmin(caller)) {
    return undefined
  }
  const own = await deps.directory.membershipOf(caller.organizationId, caller.userId)
  if (own === undefined) {
    return []
  }
  if (caller.role === 'manager') {
    return [own, ...(await deps.directory.teamRepsOf(caller.organizationId, own))]
  }
  return [own]
}

/** Resolves the Line a Call is placed from: the one named, or the Rep's own assigned Line. */
async function lineFor(
  deps: CallDeps,
  caller: Caller,
  membershipId: string,
  lineId: PlaceCallRequest['lineId']
) {
  if (lineId !== undefined) {
    const line = await deps.lines.get(caller.organizationId, lineId)
    if (line === undefined) {
      throw domainError(VOICE_ERRORS['line.not_found'])
    }
    if (line.state !== 'active') {
      throw domainError(VOICE_ERRORS['call.line_unavailable'])
    }
    return line
  }
  const [own] = await deps.lines.list(caller.organizationId, {
    limit: 1,
    state: 'active',
    assignedToRep: membershipId,
  })
  if (own === undefined) {
    throw domainError(VOICE_ERRORS['call.line_unavailable'])
  }
  return own
}

/** Fails the Call, hangs the provider call up when there is one, and logs; never throws. */
async function failCall(
  deps: CallDeps,
  organizationId: Caller['organizationId'],
  call: StoredCall,
  failureReason: VoiceCallFailureReason,
  providerCallId: string | undefined
): Promise<void> {
  try {
    await deps.calls.transition(organizationId, call.id, {
      to: 'failed',
      at: deps.clock.now(),
      failureReason,
    })
  } catch (error) {
    if (!(error instanceof InvalidTransitionError)) {
      deps.logger.error('call.fail.unrecorded', { callId: call.id })
    }
  }
  if (providerCallId !== undefined) {
    await withinDeadline(deps, (options) =>
      deps.telephony.hangUp({ organizationId, providerCallId, by: 'system' }, options)
    ).catch(() => deps.logger.warn('call.hangup.failed', { callId: call.id }))
  }
  deps.logger.warn('call.failed', { callId: call.id, reason: failureReason })
}

/**
 * Dials a `ringing` outbound Call and leaves it ringing. The Disclosure is not played here: it
 * plays when the provider reports the Prospect answered ({@link onProviderStatus}), because a
 * Disclosure sent to a call nobody has picked up is cancelled by the carrier.
 */
async function dial(
  deps: CallDeps,
  caller: Caller,
  call: StoredCall,
  from: string,
  to: string
): Promise<StoredCall> {
  const org = caller.organizationId
  let providerCallId: string | undefined
  try {
    const placed = await withinDeadline(deps, (options) =>
      deps.telephony.placeCall(
        { organizationId: org, callId: call.id, idempotencyKey: call.id, from, to },
        options
      )
    )
    providerCallId = placed.providerCallId
    await deps.calls.setProviderCallSid(org, call.id, providerCallId)
  } catch (error) {
    await failCall(deps, org, call, reasonOf(error), providerCallId)
    throw domainError(ERRORS['server.unavailable'])
  }
  return { ...call, providerCallSid: providerCallId }
}

/** The work still running after a provider callback returned; tests wait on it with {@link idle}. */
const background = new Set<Promise<unknown>>()

/** Resolves when every background Call setup started by a provider callback has finished. */
export async function idle(): Promise<void> {
  while (background.size > 0) {
    await Promise.allSettled([...background])
  }
}

/** How each provider status that ends a ringing Call is recorded as its failure reason. */
const RINGING_FAILURES: Partial<Record<TelephonyEventType, VoiceCallFailureReason>> = {
  no_answer: 'no_answer',
  busy: 'busy',
  failed: 'provider_error',
  completed: 'carrier_dropped',
}

/**
 * Applies the provider's status report to an outbound Call that is still ringing: answered starts
 * the Disclosure, bridge and Recording in the background (the webhook must answer well inside the
 * provider's timeout), and a refusal, no answer or hang-up before answer fails the Call. Safe to
 * run twice for one event: only the `ringing` to `connecting` move starts the setup. Inbound Calls
 * and Calls past `ringing` are left alone. The setup is in-process; a crash after the claim leaves
 * the Call `connecting` until `sweepStaleOutbound` fails it.
 */
export async function onProviderStatus(
  deps: CallDeps,
  organizationId: Caller['organizationId'],
  callId: VoiceCall['id'],
  type: TelephonyEventType
): Promise<void> {
  const stored = await deps.calls.get(organizationId, callId)
  if (stored === undefined || stored.direction !== 'outbound' || stored.state !== 'ringing') {
    return
  }
  const providerCallId = stored.providerCallSid
  if (type === 'answered') {
    if (providerCallId === null || stored.repMembershipId === null) {
      // The dial has not stored the provider's id yet; if the provider does not retry the 5xx,
      // `sweepStaleOutbound` fails the Call.
      throw domainError(ERRORS['server.unavailable'])
    }
    const claimed = await deps.calls
      .transition(organizationId, callId, { to: 'connecting', at: deps.clock.now() })
      .catch((error: unknown) => {
        if (error instanceof InvalidTransitionError) {
          return undefined
        }
        throw error
      })
    if (claimed === undefined) {
      return
    }
    const membershipId = stored.repMembershipId
    const setup = finish(deps, organizationId, membershipId, stored, providerCallId, stored.copilot)
    const task = setup.catch((error: unknown) =>
      deps.logger.warn('call.setup.failed', { callId, error: describeError(error) })
    )
    background.add(task)
    task.finally(() => background.delete(task))
    return
  }
  const reason = RINGING_FAILURES[type]
  if (reason !== undefined) {
    await failCall(deps, organizationId, stored, reason, undefined)
  }
}

/**
 * Takes a `connecting` Call, outbound or inbound, to `live`: play the Disclosure, bridge the Rep's
 * browser and start the Recording. The Disclosure comes first on every path and is stored before
 * the Call can go live (ADR 0003). Returns the final Call.
 */
async function finish(
  deps: CallDeps,
  org: Caller['organizationId'],
  membershipId: string,
  call: StoredCall,
  providerCallId: string,
  copilot = false
): Promise<StoredCall> {
  const wording = copilot ? COPILOT_DISCLOSURE_WORDING : DISCLOSURE_WORDING
  let phase: 'start' | 'disclosure' | 'after' = 'start'
  try {
    await deps.calls.transition(org, call.id, { to: 'disclosing', at: deps.clock.now() })

    phase = 'disclosure'
    const played = await withinDeadline(
      deps,
      (options) =>
        deps.telephony.playDisclosure(
          {
            organizationId: org,
            providerCallId,
            wordingVersion: wording.version,
            text: wording.text,
            aiAssisted: wording.aiAssisted,
          },
          options
        ),
      deps.numberTimeoutMs + DISCLOSURE_SPEECH_ALLOWANCE_MS
    )
    await deps.calls.recordDisclosure(org, call.id, {
      wordingVersion: played.wordingVersion,
      aiAssisted: played.aiAssisted,
      playedAt: new Date(played.playedAt),
    })

    phase = 'after'
    await withinDeadline(deps, (options) =>
      deps.telephony.bridge(
        {
          organizationId: org,
          providerCallId,
          repIdentity: membershipId as Parameters<typeof deps.telephony.bridge>[0]['repIdentity'],
        },
        options
      )
    )
    await withinDeadline(deps, (options) =>
      deps.telephony.startRecording({ organizationId: org, providerCallId }, options)
    )
    await deps.calls.recordRecordingStarted(org, call.id, deps.clock.now())
    const live = await deps.calls.transition(org, call.id, { to: 'live', at: deps.clock.now() })
    if (copilot) {
      // The Transcript never decides the Call: a failure to start it is logged and the Call goes on.
      await Transcript.start(deps, org, call.id).catch((error: unknown) =>
        deps.logger.warn('transcript.start_error', { callId: call.id, error: describeError(error) })
      )
    }
    return live ?? call
  } catch (error) {
    const reason: VoiceCallFailureReason =
      phase === 'disclosure'
        ? 'disclosure_failed'
        : phase === 'start'
          ? reasonOf(error)
          : 'provider_error'
    await failCall(deps, org, call, reason, providerCallId)
    if (phase === 'disclosure') {
      throw domainError(VOICE_ERRORS['call.disclosure_failed'], { callId: call.id })
    }
    throw domainError(ERRORS['server.unavailable'])
  }
}

/**
 * Places a Call from the Rep's browser: records it `ringing` under the `Idempotency-Key`, then
 * dials and leaves it ringing; the Disclosure, bridge and Recording follow when the Prospect
 * answers. A repeat of the key answers the stored first
 * answer (`replayed`) and dials nothing. A Contact Check denial would be a warning, never a refusal
 * (ADR 0003); the check is not wired yet, so `warnings` is empty.
 */
export async function place(
  deps: CallDeps,
  caller: Caller,
  request: PlaceCallRequest,
  idempotencyKey: string
): Promise<IdempotentAnswer<201, PlacedCall> & { call: VoiceCall }> {
  requireVoiceRole(caller)
  const to = normaliseNumber(request.to)
  const membershipId = await deps.directory.membershipOf(caller.organizationId, caller.userId)
  if (membershipId === undefined) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  const line = await lineFor(deps, caller, membershipId, request.lineId)

  const answer = await deps.idempotency.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: idempotencyKey,
        route: PLACE_CALL_ROUTE,
        request: { ...request, to },
        status: 201,
        response: placedCallSchema,
      },
      async (): Promise<PlacedCall> => {
        const stored = await deps.calls.insert(
          caller.organizationId,
          {
            id: formatId('call', crypto.randomUUID()),
            lineId: line.id,
            repMembershipId: membershipId,
            prospectId: request.prospectId ?? null,
            prospectNumber: to,
            copilot: request.copilot ?? false,
            idempotency: {
              key: new Bun.CryptoHasher('sha256')
                .update(`${caller.userId}|${PLACE_CALL_ROUTE}|${idempotencyKey}`)
                .digest('hex'),
              fingerprint: requestHash(PLACE_CALL_ROUTE, { ...request, to }),
            },
            createdAt: deps.clock.now(),
          },
          scope
        )
        return { call: toCall(stored), warnings: [] }
      }
    )
  )
  if (answer.replayed) {
    const current = await deps.calls.get(caller.organizationId, answer.body.call.id)
    const call = current === undefined ? answer.body.call : toCall(current)
    return { ...answer, body: { ...answer.body, call }, call }
  }
  const final = await dial(
    deps,
    caller,
    {
      ...answer.body.call,
      providerCallSid: null,
      agentCostMicroCents: 0,
      copilot: request.copilot ?? false,
      transcriptUnavailable: null,
    },
    line.number,
    to
  )
  return { ...answer, call: toCall(final) }
}

/** Reads one Call the caller may see; any other Call, in any Organization, is `call.not_found`. */
export async function get(deps: CallDeps, caller: Caller, id: VoiceCall['id']): Promise<VoiceCall> {
  const reps = await visibleReps(deps, caller)
  const stored = await deps.calls.get(caller.organizationId, id)
  if (
    stored === undefined ||
    (reps !== undefined &&
      (stored.repMembershipId === null || !reps.includes(stored.repMembershipId)))
  ) {
    throw domainError(SALES_HISTORY_ERRORS['call.not_found'])
  }
  const row = await deps.recordings.get(caller.organizationId, id)
  return { ...toCall(stored), recordingState: row?.state ?? 'none' }
}

/** Lists the Calls the caller may see, newest first, one cursor-paginated page at a time. */
export async function list(deps: CallDeps, caller: Caller, query: ListVoiceCallsQuery) {
  const reps = await visibleReps(deps, caller)
  const cursor =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, voiceCallCursorSchema)
  if (query.cursor !== undefined && cursor === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const rows = await deps.calls.list(caller.organizationId, {
    limit: query.limit + PAGE_PROBE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(reps === undefined ? {} : { repMembershipIds: reps }),
    ...(query.state === undefined ? {} : { state: query.state }),
    ...(query.direction === undefined ? {} : { direction: query.direction }),
    ...(query.repMembershipId === undefined ? {} : { repMembershipId: query.repMembershipId }),
    ...(query.lineId === undefined ? {} : { lineId: query.lineId }),
    ...(query.prospectId === undefined ? {} : { prospectId: query.prospectId }),
    ...(query.from === undefined ? {} : { from: new Date(query.from) }),
    ...(query.to === undefined ? {} : { to: new Date(query.to) }),
  })
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  const states =
    page.length === 0
      ? new Map()
      : await deps.recordings.states(
          caller.organizationId,
          page.map((c) => c.id)
        )
  return {
    items: page.map((c) => ({ ...toCall(c), recordingState: states.get(c.id) ?? 'none' })),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  }
}

/**
 * Stores the wrap-up (a Deal link and a note) of an ended Call. Only the Rep who took the Call and
 * an Owner or Admin may; to anyone else the Call does not exist. A Call that has not ended is
 * `call.not_ended`.
 */
export async function wrapUp(
  deps: CallDeps,
  caller: Caller,
  id: VoiceCall['id'],
  request: WrapUpRequest
): Promise<VoiceCall> {
  requireVoiceRole(caller)
  const stored = await deps.calls.get(caller.organizationId, id)
  if (stored === undefined) {
    throw domainError(SALES_HISTORY_ERRORS['call.not_found'])
  }
  if (!isAdmin(caller)) {
    const own = await deps.directory.membershipOf(caller.organizationId, caller.userId)
    if (own === undefined || own !== stored.repMembershipId || caller.role === 'manager') {
      throw domainError(SALES_HISTORY_ERRORS['call.not_found'])
    }
  }
  if (stored.state !== 'ended') {
    throw domainError(VOICE_ERRORS['call.not_ended'])
  }
  const updated = await deps.calls.wrapUp(caller.organizationId, id, request)
  if (updated === undefined) {
    throw domainError(SALES_HISTORY_ERRORS['call.not_found'])
  }
  return toCall(updated)
}

/**
 * Ends a live Call: the provider reported it over. Used by the provider-callback handler (a later
 * ticket); there is no route for it. A Call that is not live is left as it is.
 */
export async function end(
  deps: CallDeps,
  organizationId: string,
  id: VoiceCall['id'],
  ended: { by: NonNullable<VoiceCall['endedBy']>; at: Date }
): Promise<StoredCall | undefined> {
  try {
    const done = await deps.calls.transition(organizationId, id, {
      to: 'ended',
      at: ended.at,
      endedBy: ended.by,
    })
    await Transcript.stop(deps, id)
    return done
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      return undefined
    }
    throw error
  }
}

/** The most Reps one inbound Call rings, the telephony port's own cap on legs. */
const MAX_RINGING_REPS = 50

/**
 * Records an inbound Call as `missed` and ends the provider call. Does nothing when the Call was
 * answered or already missed, so the ring timer and a retry are both safe.
 */
async function miss(
  deps: CallDeps,
  organizationId: Caller['organizationId'],
  call: StoredCall
): Promise<void> {
  // A Rep who claimed the Call (connecting) has won the race; only a still-ringing Call is missed.
  if ((await deps.calls.get(organizationId, call.id))?.state !== 'ringing') {
    return
  }
  try {
    await deps.calls.transition(organizationId, call.id, { to: 'missed', at: deps.clock.now() })
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      return
    }
    throw error
  }
  if (call.providerCallSid !== null) {
    const providerCallId = call.providerCallSid
    await withinDeadline(deps, (options) =>
      deps.telephony.hangUp({ organizationId, providerCallId, by: 'system' }, options)
    ).catch(() => deps.logger.warn('call.hangup.failed', { callId: call.id }))
  }
  deps.logger.info('call.missed', { callId: call.id })
}

/** The Memberships an inbound Call to the Line rings: its assigned Rep, or its Team's online Reps. */
export async function ringSet(
  deps: CallDeps,
  organizationId: Caller['organizationId'],
  line: StoredLine
): Promise<string[]> {
  if (line.assignment.kind === 'rep') {
    return [line.assignment.membershipId]
  }
  if (line.assignment.kind === 'team') {
    return (await deps.directory.onlineRepsOfTeam(organizationId, line.assignment.teamId)).slice(
      0,
      MAX_RINGING_REPS
    )
  }
  return []
}

/**
 * Handles the provider's notice of an inbound Call to a Line: records it `ringing` once per
 * provider call id, rings the Reps, and starts the ring timer. A redelivered notice is
 * `duplicate` and changes nothing. With nobody to ring, or a provider that fails, the Call is
 * recorded `missed` at once.
 */
export async function ringInbound(
  deps: CallDeps,
  inbound: {
    organizationId: Caller['organizationId']
    line: StoredLine
    providerCallSid: string
    callerNumber: string
  }
): Promise<'ringing' | 'missed' | 'duplicate'> {
  const { organizationId, line } = inbound
  const assigned = line.assignment.kind === 'rep' ? line.assignment.membershipId : null
  const { call, created } = await deps.calls.insertInbound(organizationId, {
    id: formatId('call', crypto.randomUUID()),
    lineId: line.id,
    repMembershipId: assigned,
    callerNumber: inbound.callerNumber,
    providerCallSid: inbound.providerCallSid,
    createdAt: deps.clock.now(),
  })
  if (!created) {
    return 'duplicate'
  }
  try {
    const identities = await ringSet(deps, organizationId, line)
    if (identities.length === 0) {
      await miss(deps, organizationId, call)
      return 'missed'
    }
    await withinDeadline(deps, (options) =>
      deps.telephony.answerCall(
        {
          organizationId,
          providerCallId: inbound.providerCallSid,
          callId: call.id,
          ringIdentities: identities as Parameters<
            typeof deps.telephony.answerCall
          >[0]['ringIdentities'],
        },
        options
      )
    )
  } catch (error) {
    deps.logger.warn('call.ring.failed', {
      callId: call.id,
      errorName: error instanceof Error ? error.name : 'unknown',
    })
    await miss(deps, organizationId, call)
    return 'missed'
  }
  return 'ringing'
}

/**
 * A Rep answers a ringing inbound Call. One conditional update in the store gives the Call to the
 * first Rep; every later answer is `call.not_ringing`, except the winner's own repeat, which gets
 * the Call as it is. The winner is then bridged after the Disclosure plays. A Rep who is not
 * among those ringing, or in another Organization, finds no such Call.
 */
export async function answer(
  deps: CallDeps,
  caller: Caller,
  id: VoiceCall['id']
): Promise<VoiceCall> {
  requireVoiceRole(caller)
  const membershipId = await deps.directory.membershipOf(caller.organizationId, caller.userId)
  const stored = await deps.calls.get(caller.organizationId, id)
  const line =
    stored === undefined ? undefined : await deps.lines.get(caller.organizationId, stored.lineId)
  if (
    membershipId === undefined ||
    stored === undefined ||
    stored.direction !== 'inbound' ||
    line === undefined ||
    !(await ringSet(deps, caller.organizationId, line)).includes(membershipId)
  ) {
    throw domainError(SALES_HISTORY_ERRORS['call.not_found'])
  }
  const claimed = await deps.calls.claimInbound(
    caller.organizationId,
    id,
    membershipId,
    deps.clock.now()
  )
  if (claimed === undefined) {
    const current = await deps.calls.get(caller.organizationId, id)
    if (current?.repMembershipId === membershipId && current.state !== 'missed') {
      return toCall(current)
    }
    throw domainError(VOICE_ERRORS['call.not_ringing'])
  }
  if (claimed.providerCallSid === null) {
    throw domainError(ERRORS['server.unavailable'])
  }
  const final = await finish(
    deps,
    caller.organizationId,
    membershipId,
    claimed,
    claimed.providerCallSid
  )
  return toCall(final)
}
