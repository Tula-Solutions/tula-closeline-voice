import {
  AGENT_CALL_ERRORS,
  AGENT_CALL_ROLES,
  type AgentCall,
  type CallGateCode,
  type EnrollmentId,
  ERRORS,
  formatId,
  type LineId,
  MAX_CALL_ATTEMPTS,
  type MembershipId,
  membershipIdSchema,
  type OrganizationId,
  PROSPECT_ERRORS,
  type ProspectId,
  type RepAgentCallRequest,
  type RequestAgentCallRequest,
  type Role,
  VOICE_ERRORS,
} from 'tula-closeline-contract'
import { checkCallingWindow } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { isPaused } from '~/modules/agent-settings/service'
import type { Caller } from '~/modules/caller'
import { phoneHash } from '~/modules/recording/finish'
import { AgentCallOpenError, type LineUsage, type Settlement } from '~/ports/agent-call-store'
import type { ProspectContact, ProspectViewer } from '~/ports/prospect-directory'

/** What the Agent Call request and its gate need from the container. */
export type AgentCallRequestDeps = Pick<
  Container,
  | 'agentCalls'
  | 'prospects'
  | 'contactGuard'
  | 'lines'
  | 'agentSettings'
  | 'clock'
  | 'env'
  | 'directory'
>

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** How long a Line at its concurrent cap waits before the request is tried again. */
const CONCURRENT_RETRY_MS = 60_000
/** ADR 0030: at most one dial a day to a number, in the Prospect's zone. */
const MAX_DIALS_PER_DAY = 1
/** ADR 0030: at most three dials to a number in a rolling 7 days, across every source. */
const MAX_DIALS_PER_WEEK = 3

/** What the gate decides: dial, refuse for good, or try again later without using an attempt. */
export type GateDecision =
  | { kind: 'allow' }
  | { kind: 'blocked'; code: CallGateCode }
  | { kind: 'deferred'; code: CallGateCode; retryAt: Date }

/** What the gate looks at: the Organization, the Prospect and the Line the Call would use. */
export type GateInput = {
  organizationId: OrganizationId
  prospectId: ProspectId
  lineId: LineId
  /** How to reach the Prospect, as core knows it. */
  prospect: ProspectContact
  /** The Step this Call belongs to, when a Campaign asked. */
  step: { enrollmentId: string; stepKey: string } | null
}

/** The start of the calendar day containing `at` in `timeZone`. */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const [y, m, d] = [get('year'), get('month') - 1, get('day')]
  const local = Date.UTC(y, m, d, get('hour'), get('minute'), get('second'))
  const offset = local - Math.floor(at.getTime() / 1000) * 1000
  // shortcut: a DST change inside the day moves midnight by an hour, use Temporal if it matters.
  return new Date(Date.UTC(y, m, d) - offset)
}

/** Allow, or defer without using an attempt, by the Line's concurrent and daily dial caps. */
export function lineCapDecision(usage: LineUsage, now: Date): GateDecision {
  if (usage.open >= usage.maxConcurrentAgentCalls) {
    return {
      kind: 'deferred',
      code: 'agent_call.line_cap_reached',
      retryAt: new Date(now.getTime() + CONCURRENT_RETRY_MS),
    }
  }
  if (usage.dials >= usage.dailyAgentDialCap && usage.oldestDialAt !== null) {
    return {
      kind: 'deferred',
      code: 'agent_call.line_cap_reached',
      retryAt: new Date(usage.oldestDialAt.getTime() + DAY_MS),
    }
  }
  return { kind: 'allow' }
}

/**
 * The fixed six-step gate, the hot path of an Agent Call request (ADR 0030). It fails closed and
 * stops at the first refusal: Agents paused, Contact Check, calling window, attempt limits, then
 * the Line caps. Counts come from stored Agent Calls, never from memory. Nothing turns a step off.
 * Cost: O(1) reads (one per step, each an indexed lookup), independent of the Organization's size.
 */
export async function evaluateGate(
  deps: AgentCallRequestDeps,
  input: GateInput
): Promise<GateDecision> {
  const { organizationId, prospectId } = input
  const now = deps.clock.now()
  const blocked = (code: CallGateCode): GateDecision => ({ kind: 'blocked', code })

  if (await isPaused(deps, organizationId)) {
    return blocked('agent.paused')
  }

  const { prospect } = input
  if (prospect.phone === null) {
    return blocked('consent.missing')
  }
  const check = await deps.contactGuard
    .check({
      organizationId,
      prospectId,
      phone: prospect.phone,
      channel: 'phone',
      purpose: 'agent_initiated',
    })
    .catch(() => undefined)
  if (check === undefined) {
    return blocked('consent.unavailable')
  }
  if (!check.allowed) {
    return blocked(check.code)
  }

  const window = checkCallingWindow({
    e164: prospect.phone,
    now,
    ...(prospect.timeZone === null ? {} : { timeZoneOverride: prospect.timeZone }),
  })
  if (!window.allowed) {
    return blocked(
      window.reason === 'timezone_unknown' ? 'agent.timezone_unknown' : 'agent.outside_hours'
    )
  }

  if (input.step !== null) {
    const step = await deps.agentCalls.stepAttempts(
      organizationId,
      input.step.enrollmentId,
      input.step.stepKey
    )
    if (step.answered || step.dialed >= MAX_CALL_ATTEMPTS) {
      return blocked('agent_call.attempts_exhausted')
    }
  }
  const hash = Buffer.from(
    phoneHash(deps.env.PHONE_HASH_KEY, organizationId, prospect.phone),
    'hex'
  )
  const today = await deps.agentCalls.numberDials(
    organizationId,
    hash,
    startOfLocalDay(now, window.timeZone)
  )
  if (today.count >= MAX_DIALS_PER_DAY) {
    return blocked('agent_call.attempts_exhausted')
  }
  const week = await deps.agentCalls.numberDials(
    organizationId,
    hash,
    new Date(now.getTime() - 7 * DAY_MS)
  )
  if (week.count >= MAX_DIALS_PER_WEEK) {
    return blocked('agent_call.attempts_exhausted')
  }

  const usage = await deps.agentCalls.lineUsage(
    organizationId,
    input.lineId,
    new Date(now.getTime() - DAY_MS)
  )
  if (usage === undefined) {
    throw domainError(VOICE_ERRORS['line.not_found'])
  }
  return lineCapDecision(usage, now)
}

/** The Line a Call goes out on: the one asked for, or the Organization's first active one. */
async function resolveLine(
  deps: AgentCallRequestDeps,
  organizationId: OrganizationId,
  lineId: LineId | null
) {
  const line =
    lineId === null
      ? (await deps.lines.list(organizationId, { limit: 1, state: 'active' }))[0]
      : await deps.lines.get(organizationId, lineId)
  if (line === undefined || line.state === 'released') {
    throw domainError(VOICE_ERRORS['line.not_found'])
  }
  return line.id
}

type Source =
  | { kind: 'campaign_step'; enrollmentId: EnrollmentId; stepKey: string; attempt: number }
  | { kind: 'rep_request'; membershipId: MembershipId }

type RequestInput = {
  organizationId: OrganizationId
  idempotencyKey: string
  prospectId: ProspectId
  lineId: LineId | null
  goal: string | null
  source: Source
  viewer?: ProspectViewer
}

/** Records one request: a replay answers the stored row; otherwise the gate decides what is stored. */
async function request(
  deps: AgentCallRequestDeps,
  input: RequestInput
): Promise<{ call: AgentCall; created: boolean }> {
  const { organizationId } = input
  const replay = await deps.agentCalls.byKey(organizationId, input.idempotencyKey)
  // A replay must pass the same visibility check as a new request, so a key never reads a row.
  const prospect = await deps.prospects.lookup(organizationId, input.prospectId, input.viewer)
  if (prospect === undefined) {
    throw domainError(PROSPECT_ERRORS['prospect.not_found'])
  }
  if (replay !== undefined) {
    const sameAsk =
      replay.prospectId === input.prospectId &&
      replay.source === input.source.kind &&
      (input.lineId === null || replay.lineId === input.lineId) &&
      (input.source.kind !== 'rep_request' ||
        replay.requestedByMembershipId === input.source.membershipId)
    if (!sameAsk) {
      throw domainError(ERRORS['request.idempotency_key_reused'])
    }
    return { call: replay, created: false }
  }
  const lineId = await resolveLine(deps, organizationId, input.lineId)
  const open = await deps.agentCalls.openFor(organizationId, input.prospectId)
  if (open !== undefined) {
    throw domainError(AGENT_CALL_ERRORS['agent_call.duplicate'], { agentCallId: open.id })
  }
  const campaign = input.source.kind === 'campaign_step' ? input.source : null
  const decision = await evaluateGate(deps, {
    organizationId,
    prospectId: input.prospectId,
    lineId,
    prospect,
    step:
      campaign === null ? null : { enrollmentId: campaign.enrollmentId, stepKey: campaign.stepKey },
  })
  const now = deps.clock.now()
  // The name is kept so the opening says it without a call to core; a missing one is spoken generically.
  const organizationName = await deps.directory.nameOf(organizationId).catch(() => undefined)
  try {
    return await deps.agentCalls.insert(organizationId, {
      id: formatId('acl', crypto.randomUUID()),
      idempotencyKey: input.idempotencyKey,
      source: input.source.kind,
      prospectId: input.prospectId,
      lineId,
      enrollmentId: campaign?.enrollmentId ?? null,
      stepKey: campaign?.stepKey ?? null,
      requestedByMembershipId:
        input.source.kind === 'rep_request' ? input.source.membershipId : null,
      attempt: campaign?.attempt ?? 1,
      state: decision.kind === 'blocked' ? 'ended' : 'queued',
      result: decision.kind === 'blocked' ? 'blocked' : null,
      gateCode: decision.kind === 'allow' ? null : decision.code,
      // An allowed request is due now; T8's dialer picks it up and runs the gate again first.
      retryAt:
        decision.kind === 'blocked' ? null : decision.kind === 'deferred' ? decision.retryAt : now,
      createdAt: now,
      goal: input.goal,
      organizationName: organizationName ?? null,
    })
  } catch (error) {
    if (error instanceof AgentCallOpenError) {
      throw domainError(AGENT_CALL_ERRORS['agent_call.duplicate'], {
        agentCallId: error.agentCallId,
      })
    }
    throw error
  }
}

/** Outbound asks for the Call of a call Step; the Organization is the trusted caller's header. */
export function requestFromOutbound(
  deps: AgentCallRequestDeps,
  organizationId: OrganizationId,
  body: RequestAgentCallRequest
) {
  // The table requires a Step's key to be `enrollment:step:attempt`; refuse anything else here.
  if (body.idempotencyKey !== `${body.enrollmentId}:${body.stepKey}:${body.attempt}`) {
    throw domainError(ERRORS['request.invalid'])
  }
  return request(deps, {
    organizationId,
    idempotencyKey: body.idempotencyKey,
    prospectId: body.prospectId,
    lineId: body.lineId,
    goal: body.goal ?? null,
    source: {
      kind: 'campaign_step',
      enrollmentId: body.enrollmentId,
      stepKey: body.stepKey,
      attempt: body.attempt,
    },
  })
}

/** A Rep, Manager, Admin or Owner asks the Agent to call a Prospect they can see, now. */
export async function requestFromRep(
  deps: AgentCallRequestDeps,
  caller: Caller,
  idempotencyKey: string,
  body: RepAgentCallRequest
) {
  if (!(AGENT_CALL_ROLES as readonly Role[]).includes(caller.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  const membershipId = await deps.directory.membershipOf(caller.organizationId, caller.userId)
  if (membershipId === undefined) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  // A Step's key is `enrollment:step:attempt`; a Rep key with a colon could pre-empt a Step row.
  if (idempotencyKey.includes(':')) {
    throw domainError(ERRORS['request.invalid'])
  }
  return request(deps, {
    organizationId: caller.organizationId,
    idempotencyKey,
    prospectId: body.prospectId,
    lineId: body.lineId,
    goal: body.goal ?? null,
    source: { kind: 'rep_request', membershipId: membershipIdSchema.parse(membershipId) },
    viewer: { userId: caller.userId, role: caller.role },
  })
}

/**
 * Runs the gate again on a queued Agent Call, as the dialer must just before dialing, and stores a
 * refusal or a deferral on the row. `allow` means the row is still queued and may be dialed.
 */
export async function recheck(
  deps: AgentCallRequestDeps,
  organizationId: OrganizationId,
  agentCallId: string
): Promise<GateDecision | undefined> {
  const call = await deps.agentCalls.get(organizationId, agentCallId)
  if (call === undefined || call.state !== 'queued' || call.lineId === null) {
    return undefined
  }
  const prospect = await deps.prospects.lookup(organizationId, call.prospectId)
  if (prospect === undefined) {
    throw domainError(PROSPECT_ERRORS['prospect.not_found'])
  }
  const decision = await evaluateGate(deps, {
    organizationId,
    prospectId: call.prospectId,
    lineId: call.lineId,
    prospect,
    step:
      call.enrollmentId === null || call.stepKey === null
        ? null
        : { enrollmentId: call.enrollmentId, stepKey: call.stepKey },
  })
  if (decision.kind !== 'allow') {
    const settlement: Settlement =
      decision.kind === 'blocked'
        ? { kind: 'blocked', gateCode: decision.code, at: deps.clock.now() }
        : { kind: 'deferred', gateCode: decision.code, retryAt: decision.retryAt }
    await deps.agentCalls.settle(organizationId, agentCallId, settlement)
  }
  return decision
}
