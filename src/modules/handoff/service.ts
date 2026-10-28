import {
  AGENT_ERRORS,
  AGENT_ROUTES,
  ERRORS,
  type Handoff,
  MAX_HANDOFF_CONTEXT_TURNS,
  type OrganizationId,
  type VoiceCall,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { domainError } from '~/http/domain-error'
import * as Calls from '~/modules/call/service'
import type { Caller } from '~/modules/caller'
import * as Transcript from '~/modules/transcript/service'
import { type HandoffResult, MAX_HANDOFF_ATTEMPTS } from '~/ports/handoff-store'

/** What the Handoff service needs from the container. */
export type HandoffDeps = Calls.CallDeps & Pick<Container, 'handoffs' | 'turns' | 'sleep'>

/** How often a ringing Handoff is checked for the Rep's answer, in ms. */
const POLL_MS = 500

/** Above any turn index a Call can reach, so `recent` reads the latest turns. */
const END_OF_CALL = 2_000_000_000

/** The longest text one Transcript turn holds. */
const MAX_TURN_TEXT = 4_000

/** How a Handoff attempt run ended. */
export type StartOutcome =
  | { kind: 'not_live' }
  | { kind: 'already' }
  | { kind: 'bridged'; handoff: Handoff }
  | { kind: 'booking_offered' }

/**
 * Hands a live Agent Call to a Rep. Offers it to the Call's Reps one at a time (the Line's Rep, or
 * its Team's online Reps), each for `HANDOFF_RING_TIMEOUT_MS`; a decline or silence moves on. The
 * first to accept is bridged after the Handoff Disclosure plays, and the Copilot starts with the
 * earlier turns. When nobody takes it the attempt is stored as `no_rep` and the Agent offers a
 * Booking. A Call that already has a Handoff, a Rep, or is not live does nothing.
 */
export async function start(
  deps: HandoffDeps,
  input: { organizationId: OrganizationId; callId: VoiceCall['id']; reason: Handoff['reason'] }
): Promise<StartOutcome> {
  const { organizationId, callId, reason } = input
  const call = await deps.calls.get(organizationId, callId)
  if (
    call === undefined ||
    call.state !== 'live' ||
    call.repMembershipId !== null ||
    call.providerCallSid === null
  ) {
    return { kind: 'not_live' }
  }
  if ((await deps.handoffs.forCall(organizationId, callId)).length > 0) {
    return { kind: 'already' }
  }
  const line = await deps.lines.get(organizationId, call.lineId)
  const reps =
    line === undefined
      ? []
      : (await Calls.ringSet(deps, organizationId, line)).slice(0, MAX_HANDOFF_ATTEMPTS)

  let attempt = 0
  for (const repMembershipId of reps) {
    attempt += 1
    const offered = await deps.handoffs.offer(organizationId, {
      callId,
      repMembershipId,
      attempt,
      reason,
      at: deps.clock.now(),
    })
    if (offered === undefined) {
      return { kind: 'already' }
    }
    const answered = await ring(deps, organizationId, offered)
    if (answered.state === 'accepted') {
      const bridged = await bridge(deps, organizationId, call.id, call.providerCallSid, answered)
      if (bridged !== undefined) {
        return { kind: 'bridged', handoff: bridged }
      }
      break
    }
  }
  await deps.handoffs.noRep(organizationId, {
    callId,
    reason,
    attempt: attempt + 1,
    at: deps.clock.now(),
  })
  return { kind: 'booking_offered' }
}

/** Waits for the offered Rep to answer; silence past the timeout makes it `timed_out`. */
async function ring(deps: HandoffDeps, organizationId: string, offered: Handoff): Promise<Handoff> {
  const stop = deps.clock.now().getTime() + deps.env.HANDOFF_RING_TIMEOUT_MS
  let current = offered
  while (current.state === 'pending' && deps.clock.now().getTime() < stop) {
    await deps.sleep(POLL_MS)
    current = (await deps.handoffs.get(organizationId, offered.id)) ?? current
  }
  if (current.state !== 'pending') {
    return current
  }
  // The Rep may have answered in the instant between the last read and now: re-read on a lost race.
  return (
    (await deps.handoffs.expire(organizationId, offered.id)) ??
    (await deps.handoffs.get(organizationId, offered.id)) ??
    current
  )
}

/**
 * Bridges the accepting Rep: the Handoff Disclosure plays first, then the Rep is bridged; the Rep and
 * Disclosure are stored, the Copilot opens with the earlier turns, and the Handoff completes.
 * `undefined` when the Disclosure or the bridge fails; the Handoff is then `abandoned` and the Prospect is offered a Booking.
 */
async function bridge(
  deps: HandoffDeps,
  organizationId: OrganizationId,
  callId: VoiceCall['id'],
  providerCallId: string,
  handoff: Handoff
): Promise<Handoff | undefined> {
  const repMembershipId = handoff.repMembershipId
  if (repMembershipId === null) {
    return undefined
  }
  try {
    const wording = Calls.HANDOFF_DISCLOSURE_WORDING
    const played = await Calls.withinDeadline(deps, (options) =>
      deps.telephony.playDisclosure(
        {
          organizationId,
          providerCallId,
          wordingVersion: wording.version,
          text: wording.text,
          aiAssisted: wording.aiAssisted,
        },
        options
      )
    )
    await Calls.withinDeadline(deps, (options) =>
      deps.telephony.bridge(
        {
          organizationId,
          providerCallId,
          repIdentity: repMembershipId as Parameters<
            typeof deps.telephony.bridge
          >[0]['repIdentity'],
        },
        options
      )
    )
    // The Rep is on the Call from here: nothing below may abandon the Handoff.
    await afterBridge(deps, organizationId, callId, repMembershipId, played)
    return await complete(deps, organizationId, handoff, 'bridged')
  } catch (error) {
    deps.logger.warn('handoff.bridge_failed', { callId, error: describeError(error) })
    await complete(deps, organizationId, handoff, 'abandoned').catch(() => undefined)
    return undefined
  }
}

/** Stores the Rep and Disclosure on the Call, seeds the Copilot and starts it; each failure is logged. */
async function afterBridge(
  deps: HandoffDeps,
  organizationId: OrganizationId,
  callId: VoiceCall['id'],
  repMembershipId: string,
  played: { wordingVersion: number; aiAssisted: boolean; playedAt: string }
): Promise<void> {
  const log = (step: string) => (error: unknown) =>
    deps.logger.warn(`handoff.${step}_error`, { callId, error: describeError(error) })
  await deps.calls
    .joinRep(organizationId, callId, {
      repMembershipId,
      disclosure: {
        wordingVersion: played.wordingVersion,
        aiAssisted: played.aiAssisted,
        playedAt: new Date(played.playedAt),
      },
    })
    .catch(log('join_rep'))
  await seedTurns(deps, organizationId, callId).catch(log('seed'))
  await Transcript.start(deps, organizationId, callId).catch(log('transcript'))
}

const complete = (
  deps: HandoffDeps,
  organizationId: string,
  handoff: Handoff,
  result: HandoffResult
) => deps.handoffs.complete(organizationId, handoff.id, result, deps.clock.now())

/**
 * Writes the Agent's earlier exchange into the Transcript so the Rep's Copilot starts with it.
 * shortcut: the Agent's words go on the `rep` track and the Prospect's on `prospect`, with the turn
 * index as a stand-in time; replace when the Transcript carries a speaker for the Agent.
 */
async function seedTurns(
  deps: HandoffDeps,
  organizationId: string,
  callId: VoiceCall['id']
): Promise<void> {
  const turns = await deps.turns.recent(
    organizationId,
    { kind: 'call', id: callId },
    END_OF_CALL,
    MAX_HANDOFF_CONTEXT_TURNS
  )
  for (const turn of turns) {
    await deps.callTurns.append(organizationId, callId, {
      track: turn.role === 'agent' ? 'rep' : 'prospect',
      text: turn.text.slice(0, MAX_TURN_TEXT),
      startMs: turn.index,
      endMs: turn.index,
    })
  }
}

/** Which Rep is answering: the caller's Membership, or `handoff.not_found` for anyone else's offer. */
async function ownHandoff(
  deps: HandoffDeps,
  caller: Caller,
  id: Handoff['id']
): Promise<{ handoff: Handoff; membershipId: string }> {
  if (!(AGENT_ROUTES.acceptHandoff.roles as readonly string[]).includes(caller.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  const membershipId = await deps.directory.membershipOf(caller.organizationId, caller.userId)
  const handoff = await deps.handoffs.get(caller.organizationId, id)
  if (
    membershipId === undefined ||
    handoff === undefined ||
    handoff.repMembershipId !== membershipId
  ) {
    throw domainError(AGENT_ERRORS['handoff.not_found'])
  }
  return { handoff, membershipId }
}

/** The Rep accepts the Call offered to them. A repeat of an accepted offer answers the same Handoff. */
export async function accept(
  deps: HandoffDeps,
  caller: Caller,
  id: Handoff['id']
): Promise<Handoff> {
  const { handoff, membershipId } = await ownHandoff(deps, caller, id)
  const updated = await deps.handoffs.answer(
    caller.organizationId,
    id,
    membershipId,
    'accepted',
    deps.clock.now()
  )
  if (updated !== undefined) {
    return updated
  }
  const now = (await deps.handoffs.get(caller.organizationId, id)) ?? handoff
  if (now.state === 'accepted' || now.state === 'completed') {
    return now
  }
  throw domainError(AGENT_ERRORS['handoff.not_pending'])
}

/** The Rep declines the Call offered to them. A repeat of a decline answers the same Handoff. */
export async function decline(
  deps: HandoffDeps,
  caller: Caller,
  id: Handoff['id']
): Promise<Handoff> {
  const { handoff, membershipId } = await ownHandoff(deps, caller, id)
  const updated = await deps.handoffs.answer(
    caller.organizationId,
    id,
    membershipId,
    'declined',
    deps.clock.now()
  )
  if (updated !== undefined) {
    return updated
  }
  const now = (await deps.handoffs.get(caller.organizationId, id)) ?? handoff
  if (now.state === 'declined') {
    return now
  }
  throw domainError(AGENT_ERRORS['handoff.not_pending'])
}
