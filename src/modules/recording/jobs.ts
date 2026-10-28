import { formatId, type OrganizationId, organizationIdSchema } from 'tula-closeline-contract'
import type { Logger, Queue } from 'tula-closeline-kit'
import { type Container, reportSafely } from '~/container'
import { type Schedule, startSchedule } from '~/modules/purge/schedule'
import { type FinishDeps, finish, isFinal } from '~/modules/recording/finish'
import { finishRecordingMessage, type JobEnvelope, jobRegistry } from '~/modules/recording/messages'
import type { CallStore, StoredCall } from '~/ports/call-store'

/** The most batches one run takes off the queue; the next run takes the rest. */
const MAX_BATCHES_PER_RUN = 50

/** How long a job stays hidden while it runs; an unfinished job comes back after this. */
const VISIBILITY_SECONDS = 60

/** Queues a job to finish a Call's Recording (or just its event); `recordingSid` null means the Call ended. */
export async function enqueueFinish(
  jobs: Pick<Queue<JobEnvelope>, 'publish'>,
  organizationId: string,
  callId: StoredCall['id'],
  recordingSid: string | null
): Promise<void> {
  await jobs.publish(
    jobRegistry.create({
      type: finishRecordingMessage.type,
      traceId: callId,
      organizationId: organizationId as OrganizationId,
      payload: { callId, recordingSid },
    })
  )
}

/**
 * Wraps the Call store so that every Call that reaches a final state queues its finishing job.
 * A failed enqueue is logged and does not undo the state change.
 */
// shortcut: no outbox, so a crash between the state change and the enqueue loses the job and that
// Call's event; add an outbox row in the same transaction when a consumer must see every Call.
export function publishOnFinal<T extends CallStore>(
  calls: T,
  jobs: Pick<Queue<JobEnvelope>, 'publish'>,
  logger: Logger
): T {
  const enqueue = async (organizationId: string, call: StoredCall | undefined): Promise<void> => {
    if (call === undefined || !isFinal(call.state)) {
      return
    }
    await enqueueFinish(jobs, organizationId, call.id, null).catch((error: unknown) =>
      logger.warn('recording.enqueue_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      })
    )
  }
  return {
    ...calls,
    transition: async (organizationId, id, transition) => {
      const call = await calls.transition(organizationId, id, transition)
      await enqueue(organizationId, call)
      return call
    },
    missStaleRinging: async (organizationId, before, at, limit) => {
      const missed = await calls.missStaleRinging(organizationId, before, at, limit)
      for (const call of missed) {
        await enqueue(organizationId, call)
      }
      return missed
    },
  }
}

/** What the worker needs from the container. */
export type JobDeps = FinishDeps & Pick<Container, 'jobs' | 'logger'>

/**
 * Takes finishing jobs off the queue until it is empty (or `maxBatches` batches), finishing each
 * and removing it only when done. A job that cannot finish, or throws, stays and comes back when
 * its visibility timeout passes; after the queue's receive limit it goes to the dead-letter queue.
 * Returns how many jobs it finished.
 */
export async function runJobs(
  deps: JobDeps,
  options: { shouldStop: () => boolean; maxBatches?: number }
): Promise<number> {
  let finished = 0
  for (let batch = 0; batch < (options.maxBatches ?? MAX_BATCHES_PER_RUN); batch++) {
    if (options.shouldStop()) {
      break
    }
    const deliveries = await deps.jobs.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: VISIBILITY_SECONDS,
      waitSeconds: 0,
    })
    if (deliveries.length === 0) {
      break
    }
    for (const delivery of deliveries) {
      if (delivery.kind !== 'message') {
        deps.logger.warn('recording.job_invalid')
        continue
      }
      const { envelope } = delivery
      try {
        if (
          await finish(deps, organizationIdSchema.parse(envelope.organizationId), envelope.payload)
        ) {
          await deps.jobs.acknowledge(delivery.receipt)
          finished++
        }
      } catch (error) {
        // Only the name: the error may carry a provider URL or a Prospect's number.
        deps.logger.warn('recording.job_failed', {
          callId: envelope.payload.callId,
          errorName: error instanceof Error ? error.name : 'unknown',
        })
      }
    }
  }
  return finished
}

/** Starts the job worker on a jittered interval; called from `server.ts` only. */
export function startRecordingJobs(container: Container): Schedule {
  const schedule = startSchedule({
    run: (isStopped) => runJobs(container, { shouldStop: isStopped }),
    onError: (error) =>
      reportSafely(container, error, {
        requestId: formatId('req', crypto.randomUUID()),
        method: 'JOB',
        path: 'recording-jobs',
        status: 500,
      }),
    intervalMs: container.env.RECORDING_JOBS_INTERVAL_MS,
  })
  container.logger.info('recording jobs scheduled', {
    intervalMs: container.env.RECORDING_JOBS_INTERVAL_MS,
  })
  return schedule
}
