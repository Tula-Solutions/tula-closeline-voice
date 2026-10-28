import { createApp } from '~/app'
import { createContainer } from '~/container'
import { serveOptions } from '~/http/serve'
import { startMissedSweep } from '~/modules/call/missed-sweep'
import { startTwilioPurgeSchedule } from '~/modules/purge/start'
import { startRecordingJobs } from '~/modules/recording/jobs'
import { startRecordingPurge } from '~/modules/recording/purge'
import { shutdown } from '~/shutdown'

const container = createContainer()
const app = createApp(container)
const server = Bun.serve(serveOptions(container, app))
// Only a deployment on the Postgres TwilioStore has a schedule; the timer is its only state.
const purgeSchedule = startTwilioPurgeSchedule(container)
// The ring timeout of an inbound Call is a database sweep, so any instance may miss any Call.
const missedSweep = startMissedSweep(container)
// Finishing a Call's Recording and the purge of deleted ones are queue and database work too.
const recordingJobs = startRecordingJobs(container)
const recordingPurge = startRecordingPurge(container)

container.logger.info('listening', { port: server.port, environment: container.env.ENVIRONMENT })

function stop(signal: string): void {
  void shutdown({
    signal,
    server,
    lifecycle: container.lifecycle,
    clock: container.clock,
    logger: container.logger,
    graceMs: container.env.SHUTDOWN_GRACE_MS,
    timeoutMs: container.env.SHUTDOWN_TIMEOUT_MS,
    // A clean stop releases the database connections first; a failed or forced one exits at once.
    exit: (code) => {
      if (code !== 0) {
        process.exit(code)
      }
      // The purge run in flight finishes before its database connections are released.
      Promise.all([
        purgeSchedule?.stop(),
        missedSweep.stop(),
        recordingJobs.stop(),
        recordingPurge.stop(),
      ])
        .then(() => container.close())
        .then(
          () => process.exit(0),
          () => process.exit(1)
        )
    },
  })
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
