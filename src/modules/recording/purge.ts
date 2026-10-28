import { formatId } from 'tula-closeline-contract'
import { type Container, reportSafely } from '~/container'
import { type Schedule, startSchedule } from '~/modules/purge/schedule'

/** What the purge needs from the container. */
export type PurgeDeps = Pick<Container, 'recordings' | 'storage' | 'clock' | 'logger'>

/** The Organizations asked for per page of the scan. */
const PAGE = 100

/** The most Recordings one Organization's purge removes per run; the next run takes the rest. */
const PER_ORGANIZATION = 100

/**
 * Deletes the file of every deleted Recording whose purge time has passed, then clears its purge
 * time so it is not found again. Deleting a missing file succeeds, so a repeat or a crash between
 * the two steps is harmless. Visits at most `maxOrganizations`. Returns how many it purged.
 */
export async function purgeRecordings(
  deps: PurgeDeps,
  options: { maxOrganizations: number; shouldStop: () => boolean }
): Promise<number> {
  const now = deps.clock.now()
  let after: string | null = null
  let visited = 0
  let purged = 0
  while (visited < options.maxOrganizations && !options.shouldStop()) {
    const page: string[] = await deps.recordings.organizationsWithDue(
      now,
      after,
      Math.min(PAGE, options.maxOrganizations - visited)
    )
    if (page.length === 0) {
      break
    }
    for (const organizationId of page) {
      try {
        for (const row of await deps.recordings.due(organizationId, now, PER_ORGANIZATION)) {
          await deps.storage.delete(organizationId, row.storageKey)
          await deps.recordings.finishPurge(organizationId, row.callId)
          purged++
        }
      } catch (error) {
        // One failing Organization must not starve the later ones; the next run retries it.
        deps.logger.warn('recording.purge_failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        })
      }
    }
    visited += page.length
    after = page[page.length - 1] ?? null
  }
  return purged
}

/** Starts the purge on a jittered interval; called from `server.ts` only. */
export function startRecordingPurge(container: Container): Schedule {
  const schedule = startSchedule({
    run: (isStopped) =>
      purgeRecordings(container, {
        maxOrganizations: container.env.RECORDING_PURGE_MAX_ORGANIZATIONS,
        shouldStop: isStopped,
      }),
    onError: (error) =>
      reportSafely(container, error, {
        requestId: formatId('req', crypto.randomUUID()),
        method: 'JOB',
        path: 'recording-purge',
        status: 500,
      }),
    intervalMs: container.env.RECORDING_PURGE_INTERVAL_MS,
  })
  container.logger.info('recording purge scheduled', {
    intervalMs: container.env.RECORDING_PURGE_INTERVAL_MS,
  })
  return schedule
}
