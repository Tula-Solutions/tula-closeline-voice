import {
  type AgentCall,
  type EnrollmentId,
  formatId,
  type LineId,
  type OrganizationId,
  type ProspectId,
} from 'tula-closeline-contract'
import { createFixedClock } from 'tula-closeline-kit'
import { LOCAL_INTERNAL_API_TOKEN } from '~/env'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import { phoneHash } from '~/modules/recording/finish'
import type { NewAgentCall } from '~/ports/agent-call-store'
import { createTestApp, newOrganizationId, type TestApp } from '~/testing'

/** A Monday at noon in New York, inside the calling window. */
export const NOON_NEW_YORK = '2026-01-05T17:00:00Z'
export const PHONE = '+12125550100'

/** An app whose clock stands inside the calling window, with the Agent unpaused for `org`. */
export async function setup() {
  const t = await createTestApp()
  t.deps.clock = createFixedClock(NOON_NEW_YORK)
  const org = newOrganizationId()
  await unpause(t, org)
  return { t, org, line: await addLine(t, org), prospect: addProspect(t, org) }
}

/** Turns the Agent on for the Organization. */
export async function unpause(t: TestApp, org: OrganizationId) {
  await t.deps.agentSettings.put(org, {
    ...DEFAULT_AGENT_SETTINGS,
    hours: [...DEFAULT_AGENT_SETTINGS.hours],
    paused: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
}

let lineCounter = 0

/** Stores an active Line of the Organization and returns its id. */
export async function addLine(t: TestApp, org: OrganizationId) {
  const id = formatId('line', crypto.randomUUID())
  await t.deps.lines.insert(org, {
    id,
    number: `+1415555${String(lineCounter++).padStart(4, '0')}`,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
  return id
}

/** Declares a Prospect core knows, whose Contact Check allows a call. */
export function addProspect(
  t: TestApp,
  org: OrganizationId,
  options: { phone?: string; timeZone?: string | null; visibleTo?: string[]; allow?: boolean } = {}
) {
  const id = formatId('prs', crypto.randomUUID())
  const phone = options.phone ?? PHONE
  t.deps.prospects.add(org, id, {
    phone,
    timeZone: options.timeZone === undefined ? 'America/New_York' : options.timeZone,
    visibleTo: options.visibleTo ?? [],
  })
  if (options.allow !== false) {
    t.deps.contactGuard.allow({ organizationId: org, prospectId: id, phone }, 'phone')
  }
  return id
}

/** The hash a dial to the phone number is stored under. */
export const hashOf = (t: TestApp, org: OrganizationId, phone = PHONE) =>
  Buffer.from(phoneHash(t.deps.env.PHONE_HASH_KEY, org, phone), 'hex')

/** Stores an earlier dial to the Prospect's number; `open` leaves it dialing. */
export async function seedDial(
  t: TestApp,
  org: OrganizationId,
  dial: {
    prospectId: ProspectId
    lineId: LineId
    at: Date
    open?: boolean
    answered?: boolean
    phone?: string
    enrollmentId?: EnrollmentId
    stepKey?: string
  }
) {
  const id = formatId('acl', crypto.randomUUID())
  const { call } = await t.deps.agentCalls.insert(org, {
    id,
    idempotencyKey: `seed-${crypto.randomUUID()}`,
    source: dial.enrollmentId === undefined ? 'rep_request' : 'campaign_step',
    prospectId: dial.prospectId,
    lineId: dial.lineId,
    enrollmentId: dial.enrollmentId ?? null,
    stepKey: dial.stepKey ?? null,
    requestedByMembershipId: null,
    attempt: 1,
    state: 'queued',
    result: null,
    gateCode: null,
    retryAt: dial.at,
    createdAt: dial.at,
  } satisfies NewAgentCall)
  t.deps.agentCalls.recordDial(org, call.id, {
    numberHash: hashOf(t, org, dial.phone),
    at: dial.at,
    lineId: dial.lineId,
    open: dial.open ?? false,
    answered: dial.answered ?? false,
  })
  return call.id
}

/** What the routes answer: an Agent Call, or an error. */
export type Answer = AgentCall & { error?: { code: string; details?: { agentCallId?: string } } }

/** Posts to the internal route as outbound. */
export async function askInternal(t: TestApp, org: string, body: Record<string, unknown>) {
  const response = await t.app.request('/internal/v1/agent-calls', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${LOCAL_INTERNAL_API_TOKEN}`,
      'x-organization-id': org,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Answer }
}

/** A request body for a call Step; its key is the one the table requires. */
export function stepBody(
  prospectId: string,
  lineId: string | null,
  extra: Record<string, unknown> = {}
) {
  const enrollmentId = formatId('enr', crypto.randomUUID())
  const body = { enrollmentId, stepKey: 'first_call', attempt: 1, ...extra }
  return {
    idempotencyKey: `${body.enrollmentId}:${body.stepKey}:${body.attempt}`,
    prospectId,
    lineId,
    goal: 'Book a demo.',
    ...body,
  }
}
