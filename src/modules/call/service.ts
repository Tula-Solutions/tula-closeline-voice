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
import { TELEPHONY_ERROR_CODES, TelephonyError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent, requestHash } from '~/modules/idempotency/service'
import { InvalidTransitionError, type StoredCall } from '~/ports/call-store'

/** What the Call service needs from the container. */
export type CallDeps = Pick<
  Container,
  | 'calls'
  | 'lines'
  | 'telephony'
  | 'directory'
  | 'clock'
  | 'logger'
  | 'idempotency'
  | 'numberTimeoutMs'
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
  const { providerCallSid: _providerCallSid, ...call } = stored
  return call
}

/** Runs one provider call under the deadline; a call that outlives it is `telephony.unavailable`. */
async function withinDeadline<T>(
  deps: CallDeps,
  call: (options: { timeoutMs: number }) => Promise<T>
): Promise<T> {
  const timeoutMs = deps.numberTimeoutMs
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
  caller: Caller,
  call: StoredCall,
  failureReason: VoiceCallFailureReason,
  providerCallId: string | undefined
): Promise<void> {
  try {
    await deps.calls.transition(caller.organizationId, call.id, {
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
      deps.telephony.hangUp(
        { organizationId: caller.organizationId, providerCallId, by: 'system' },
        options
      )
    ).catch(() => deps.logger.warn('call.hangup.failed', { callId: call.id }))
  }
  deps.logger.warn('call.failed', { callId: call.id, reason: failureReason })
}

/**
 * Takes a `ringing` Call through the provider: place it, play the Disclosure, bridge the Rep's
 * browser and start the Recording, and only then mark it `live`. The Disclosure comes first on
 * every path and is stored before the Call can go live (ADR 0003). Returns the final Call.
 */
async function walk(
  deps: CallDeps,
  caller: Caller,
  membershipId: string,
  call: StoredCall,
  from: string,
  to: string
): Promise<StoredCall> {
  const org = caller.organizationId
  let providerCallId: string | undefined
  let phase: 'dial' | 'disclosure' | 'after' = 'dial'
  try {
    const placed = await withinDeadline(deps, (options) =>
      deps.telephony.placeCall(
        { organizationId: org, callId: call.id, idempotencyKey: call.id, from, to },
        options
      )
    )
    providerCallId = placed.providerCallId
    await deps.calls.setProviderCallSid(org, call.id, providerCallId)
    await deps.calls.transition(org, call.id, { to: 'connecting', at: deps.clock.now() })
    await deps.calls.transition(org, call.id, { to: 'disclosing', at: deps.clock.now() })

    phase = 'disclosure'
    const played = await withinDeadline(deps, (options) =>
      deps.telephony.playDisclosure(
        {
          organizationId: org,
          providerCallId: placed.providerCallId,
          wordingVersion: DISCLOSURE_WORDING.version,
          text: DISCLOSURE_WORDING.text,
          aiAssisted: DISCLOSURE_WORDING.aiAssisted,
        },
        options
      )
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
          providerCallId: placed.providerCallId,
          repIdentity: membershipId as Parameters<typeof deps.telephony.bridge>[0]['repIdentity'],
        },
        options
      )
    )
    await withinDeadline(deps, (options) =>
      deps.telephony.startRecording(
        { organizationId: org, providerCallId: placed.providerCallId },
        options
      )
    )
    await deps.calls.recordRecordingStarted(org, call.id, deps.clock.now())
    const live = await deps.calls.transition(org, call.id, { to: 'live', at: deps.clock.now() })
    return live ?? call
  } catch (error) {
    const reason: VoiceCallFailureReason =
      phase === 'disclosure'
        ? 'disclosure_failed'
        : phase === 'dial'
          ? reasonOf(error)
          : 'provider_error'
    await failCall(deps, caller, call, reason, providerCallId)
    if (phase === 'disclosure') {
      throw domainError(VOICE_ERRORS['call.disclosure_failed'], { callId: call.id })
    }
    throw domainError(ERRORS['server.unavailable'])
  }
}

/**
 * Places a Call from the Rep's browser: records it `ringing` under the `Idempotency-Key`, then
 * dials, plays the Disclosure, bridges and records. A repeat of the key answers the stored first
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
  const final = await walk(
    deps,
    caller,
    membershipId,
    { ...answer.body.call, providerCallSid: null },
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
  return toCall(stored)
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
  return {
    items: page.map(toCall),
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
    return await deps.calls.transition(organizationId, id, {
      to: 'ended',
      at: ended.at,
      endedBy: ended.by,
    })
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      return undefined
    }
    throw error
  }
}
