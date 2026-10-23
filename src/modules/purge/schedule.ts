/** How far a delay may stray from the interval, as a fraction either way. */
export const SCHEDULE_JITTER = 0.2

/** A running schedule. */
export type Schedule = {
  /** Cancels the next run and resolves once a run already under way has finished. */
  stop: () => Promise<void>
}

/** What {@link startSchedule} needs; the timer and the random source are replaceable for tests. */
export type ScheduleOptions = {
  /** The work of one run. It must not throw; a throw is passed to `onError` and the schedule goes on. */
  run: (isStopped: () => boolean) => Promise<unknown>
  /** Called with whatever `run` threw. Must not throw. */
  onError: (error: unknown) => void
  /** The mean wait between the end of one run and the start of the next, in milliseconds. */
  intervalMs: number
  /** A number in [0, 1); defaults to `Math.random`. */
  random?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** The wait before a run: the interval, spread by up to the jitter either way. */
export function jitteredDelay(intervalMs: number, random: () => number): number {
  return Math.max(1, Math.round(intervalMs * (1 + (random() * 2 - 1) * SCHEDULE_JITTER)))
}

/**
 * Runs `run` repeatedly on a jittered interval, the next wait starting only after the previous run
 * ends, so two runs of one schedule never overlap. The first run is one interval away, not at
 * once, so a fleet that boots together does not scan together. The only state is the timer; the
 * timer does not keep the process alive.
 */
export function startSchedule(options: ScheduleOptions): Schedule {
  const random = options.random ?? Math.random
  const setTimer =
    options.setTimer ??
    ((callback, ms) => {
      const handle = setTimeout(callback, ms)
      handle.unref()
      return handle
    })
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as Timer))
  let stopped = false
  let timer: unknown
  let running: Promise<void> = Promise.resolve()

  const arm = (): void => {
    timer = setTimer(
      () => {
        running = tick()
      },
      jitteredDelay(options.intervalMs, random)
    )
  }
  const tick = async (): Promise<void> => {
    try {
      await options.run(() => stopped)
    } catch (error) {
      options.onError(error)
    }
    if (!stopped) {
      arm()
    }
  }

  arm()
  return {
    stop: async () => {
      stopped = true
      clearTimer(timer)
      await running
    },
  }
}
