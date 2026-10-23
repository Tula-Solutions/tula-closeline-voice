import { formatId } from 'tula-closeline-contract'
import { type Container, reportSafely } from '~/container'
import { boundTwilioPurgeSource } from './bound-source'
import { type Schedule, startSchedule } from './schedule'
import { runTwilioPurge } from './twilio-purge-job'

/**
 * Starts the Twilio purge on a jittered interval, or returns undefined when this deployment does
 * not use the Postgres TwilioStore (no `twilioPurge` source). Called from `server.ts` only, so a
 * test that builds the app never starts a timer.
 */
export function startTwilioPurgeSchedule(container: Container): Schedule | undefined {
  const source = container.twilioPurge
  if (source === undefined) {
    return undefined
  }
  const reportError = (error: unknown): void =>
    reportSafely(container, error, {
      requestId: formatId('req', crypto.randomUUID()),
      method: 'JOB',
      path: 'twilio-purge',
      status: 500,
    })
  const deps = {
    source: boundTwilioPurgeSource(source, container.env.TWILIO_PURGE_QUERY_TIMEOUT_MS),
    clock: container.clock,
    logger: container.logger,
    reportError,
  }
  // Only a hint where to resume; lost on restart, which just starts the scan over.
  let cursor: string | null = null
  const schedule = startSchedule({
    run: async (isStopped) => {
      const run = await runTwilioPurge(deps, {
        maxOrganizations: container.env.TWILIO_PURGE_MAX_ORGANIZATIONS,
        after: cursor,
        shouldStop: isStopped,
      })
      cursor = run.next
    },
    onError: reportError,
    intervalMs: container.env.TWILIO_PURGE_INTERVAL_MS,
  })
  container.logger.info('twilio purge scheduled', {
    intervalMs: container.env.TWILIO_PURGE_INTERVAL_MS,
  })
  return schedule
}
