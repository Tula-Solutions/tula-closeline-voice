import type { Clock, Logger } from 'tula-closeline-kit'
import { TWILIO_PURGE_PAGE_SIZE, type TwilioPurgeSource } from '~/ports/twilio-purge-source'

/** What one purge run needs from outside; the job holds no state of its own. */
export type TwilioPurgeJobDeps = {
  source: TwilioPurgeSource
  clock: Clock
  logger: Logger
  /** Reports an unexpected error to the tracker; must not throw. */
  reportError: (error: unknown) => void
}

/** What one {@link runTwilioPurge} run did. */
export type TwilioPurgeRun = {
  /** Organizations visited. */
  organizations: number
  /** Call records removed. */
  calls: number
  /** Placements removed. */
  placements: number
  /** Organizations whose purge threw (each reported). */
  failed: number
  /** Organizations a batch cap left with expired rows; the next run continues. */
  undrained: number
  /** True when the per-run Organization cap stopped the run with more Organizations waiting. */
  capped: boolean
  /** True when the scan itself failed, so the run ended early. */
  scanFailed: boolean
  /** True when `shouldStop` ended the run early. */
  stopped: boolean
  /** Where the next run should resume (the last Organization visited); null to start over. */
  next: string | null
}

/**
 * One pass over the Organizations that hold expired Twilio rows: pages the scan by cursor and
 * purges each Organization, visiting at most `maxOrganizations`. One Organization's failure is
 * reported and does not stop the others; a failing scan ends the run. The deletes are idempotent,
 * so any instance may run this at any time and a repeat does no harm.
 */
export async function runTwilioPurge(
  deps: TwilioPurgeJobDeps,
  options: {
    maxOrganizations: number
    /** Resume after this Organization id, so ones that keep failing cannot starve the rest. */
    after?: string | null
    /** Checked between Organizations; true ends the run early. */
    shouldStop?: () => boolean
  }
): Promise<TwilioPurgeRun> {
  const run: TwilioPurgeRun = {
    organizations: 0,
    calls: 0,
    placements: 0,
    failed: 0,
    undrained: 0,
    capped: false,
    scanFailed: false,
    stopped: false,
    next: null,
  }
  const now = deps.clock.now()
  let after: string | null = options.after ?? null
  while (!(run.capped || run.stopped)) {
    let page: string[]
    try {
      // One more than the room left, so a full cap with more waiting is told from an exact fit.
      const room = options.maxOrganizations - run.organizations + 1
      page = await deps.source.organizationsWithExpired(
        new Date(now),
        after,
        Math.min(TWILIO_PURGE_PAGE_SIZE, room)
      )
    } catch (error) {
      run.scanFailed = true
      deps.reportError(error)
      break
    }
    if (page.length === 0) {
      break
    }
    for (const organizationId of page) {
      if (options.shouldStop?.()) {
        run.stopped = true
        break
      }
      if (run.organizations >= options.maxOrganizations) {
        run.capped = true
        break
      }
      run.organizations += 1
      run.next = organizationId
      try {
        const result = await deps.source.purge(organizationId, new Date(now))
        run.calls += result.calls
        run.placements += result.placements
        if (!result.drained) {
          run.undrained += 1
        }
      } catch (error) {
        run.failed += 1
        deps.reportError(error)
      }
    }
    after = page[page.length - 1] ?? null
  }
  if (run.scanFailed) {
    run.next = options.after ?? null
  } else if (!(run.capped || run.stopped)) {
    run.next = null
  }
  deps.logger.info('twilio purge run', { ...run })
  return run
}
