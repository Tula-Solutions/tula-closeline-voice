import { formatId } from 'tula-closeline-contract'
import { type Container, reportSafely } from '~/container'
import type { Caller } from '~/modules/caller'
import { type Schedule, startSchedule } from '~/modules/purge/schedule'

/** What the sweep needs from the container. */
export type SweepDeps = Pick<
  Container,
  'calls' | 'telephony' | 'clock' | 'logger' | 'env' | 'numberTimeoutMs'
>

/** The most Calls one Organization's sweep marks `missed` per run; the next run takes the rest. */
export const SWEEP_CALLS_PER_ORGANIZATION = 100

/** The Organizations asked for per page of the scan. */
const PAGE = 100

/**
 * Records every inbound Call that has rung longer than `RING_TIMEOUT_MS` as `missed` and ends its
 * provider call. All state is in the database, so a restart loses nothing and any instance may
 * run it. Visits at most `maxOrganizations` Organizations. Returns how many Calls it missed.
 */
export async function sweepMissed(
  deps: SweepDeps,
  options: { maxOrganizations: number; shouldStop: () => boolean }
): Promise<number> {
  const now = deps.clock.now()
  const before = new Date(now.getTime() - deps.env.RING_TIMEOUT_MS)
  let after: string | null = null
  let visited = 0
  let missed = 0
  while (visited < options.maxOrganizations && !options.shouldStop()) {
    const page: string[] = await deps.calls.organizationsWithStaleRinging(
      before,
      after,
      Math.min(PAGE, options.maxOrganizations - visited)
    )
    if (page.length === 0) {
      break
    }
    for (const organizationId of page) {
      // One failing Organization must not starve the later ones; the next run retries it.
      const calls = await deps.calls
        .missStaleRinging(organizationId, before, now, SWEEP_CALLS_PER_ORGANIZATION)
        .catch((error: unknown) => {
          deps.logger.warn('call.sweep.failed', {
            errorName: error instanceof Error ? error.name : 'unknown',
          })
          return []
        })
      missed += calls.length
      for (const call of calls) {
        deps.logger.info('call.missed', { callId: call.id })
        if (call.providerCallSid !== null) {
          const providerCallId = call.providerCallSid
          await deps.telephony
            .hangUp(
              {
                organizationId: organizationId as Caller['organizationId'],
                providerCallId,
                by: 'system',
              },
              { timeoutMs: deps.numberTimeoutMs }
            )
            .catch(() => deps.logger.warn('call.hangup.failed', { callId: call.id }))
        }
      }
    }
    visited += page.length
    after = page[page.length - 1] ?? null
  }
  return missed
}

/**
 * Starts the missed-Call sweep on a jittered interval. Called from `server.ts` only, so a test
 * that builds the app never starts a timer. The timer is its only state.
 */
export function startMissedSweep(container: Container): Schedule {
  const reportError = (error: unknown): void =>
    reportSafely(container, error, {
      requestId: formatId('req', crypto.randomUUID()),
      method: 'JOB',
      path: 'missed-sweep',
      status: 500,
    })
  const schedule = startSchedule({
    run: (isStopped) =>
      sweepMissed(container, {
        maxOrganizations: container.env.MISSED_SWEEP_MAX_ORGANIZATIONS,
        shouldStop: isStopped,
      }),
    onError: reportError,
    intervalMs: container.env.MISSED_SWEEP_INTERVAL_MS,
  })
  container.logger.info('missed sweep scheduled', {
    intervalMs: container.env.MISSED_SWEEP_INTERVAL_MS,
  })
  return schedule
}
