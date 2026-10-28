import { type OrganizationId, organizationIdSchema } from 'tula-closeline-contract'
import { checkCallingWindow } from 'tula-closeline-kit'
import { type DialDeps, dial } from './service'

/** The Organizations asked for per page of the due scan. */
const PAGE = 100

/** The most due Agent Calls dialed for one Organization per pass, so a big queue cannot starve the rest. */
export const DIAL_PER_ORGANIZATION = 10

/** How long a queued Agent Call waits when its Prospect is outside their calling window. */
export const WINDOW_RETRY_MS = 15 * 60_000

/**
 * Dials the queued Agent Calls that are due. A row whose Prospect is outside the calling window is
 * put back for later instead of reaching the gate, which would refuse it for good. At most
 * `maxPerPass` rows are looked at; the rest wait for the next pass. One failing row or
 * Organization never stops the others. State is in the database, so any instance may run it and
 * a row another instance already claimed is `gone` for this one. Returns how many it dialed.
 */
export async function sweepDueAgentCalls(
  deps: DialDeps,
  options: { maxPerPass: number; shouldStop: () => boolean }
): Promise<number> {
  const now = deps.clock.now()
  let after: string | null = null
  let looked = 0
  let dialed = 0
  while (looked < options.maxPerPass && !options.shouldStop()) {
    const page: string[] = await deps.agentCalls.dueOrganizations(now, after, PAGE)
    if (page.length === 0) {
      break
    }
    for (const id of page) {
      const organization = organizationIdSchema.safeParse(id)
      if (!organization.success || looked >= options.maxPerPass || options.shouldStop()) {
        continue
      }
      const rows = await deps.agentCalls
        .due(id, now, Math.min(DIAL_PER_ORGANIZATION, options.maxPerPass - looked))
        .catch(() => [])
      for (const row of rows) {
        looked += 1
        dialed += (await dialOne(deps, organization.data, row.id, row.prospectId, now)) ? 1 : 0
      }
    }
    after = page[page.length - 1] ?? null
  }
  return dialed
}

async function dialOne(
  deps: DialDeps,
  organizationId: OrganizationId,
  agentCallId: string,
  prospectId: string,
  now: Date
): Promise<boolean> {
  try {
    const prospect = await deps.prospects.lookup(organizationId, prospectId)
    if (prospect?.phone == null) {
      await back(deps, organizationId, agentCallId, now)
      return false
    }
    const window = checkCallingWindow({
      e164: prospect.phone,
      now,
      ...(prospect.timeZone === null ? {} : { timeZoneOverride: prospect.timeZone }),
    })
    if (!window.allowed && window.reason !== 'timezone_unknown') {
      await back(deps, organizationId, agentCallId, now)
      return false
    }
    return (await dial(deps, organizationId, agentCallId)).kind === 'dialing'
  } catch (error) {
    deps.logger.warn('agent dial sweep failed', {
      agentCallId,
      errorName: error instanceof Error ? error.name : 'unknown',
    })
    await back(deps, organizationId, agentCallId, now).catch(() => undefined)
    return false
  }
}

/**
 * Puts a row that cannot be dialed now back by {@link WINDOW_RETRY_MS}, so it never holds the head
 * of the queue. shortcut: one gate code for every reason (window, no number, error), refine when
 * the contract has a code for each.
 */
async function back(
  deps: DialDeps,
  organizationId: OrganizationId,
  agentCallId: string,
  now: Date
): Promise<void> {
  await deps.agentCalls.settle(organizationId, agentCallId, {
    kind: 'deferred',
    gateCode: 'agent.outside_hours',
    retryAt: new Date(now.getTime() + WINDOW_RETRY_MS),
  })
}
