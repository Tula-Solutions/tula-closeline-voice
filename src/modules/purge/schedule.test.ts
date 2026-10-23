import { expect, test } from 'bun:test'
import { jitteredDelay, SCHEDULE_JITTER, startSchedule } from './schedule'

/** A manual timer: `fire` runs the callback armed last. */
function manualTimer() {
  const armed: { callback: () => void; ms: number }[] = []
  let cleared = 0
  return {
    armed,
    cleared: () => cleared,
    setTimer: (callback: () => void, ms: number) => {
      armed.push({ callback, ms })
      return armed.length
    },
    clearTimer: () => {
      cleared += 1
    },
    fire: () => armed[armed.length - 1]?.callback(),
  }
}

test('the delay stays within the jitter band around the interval', () => {
  expect(jitteredDelay(1000, () => 0)).toBe(1000 * (1 - SCHEDULE_JITTER))
  expect(jitteredDelay(1000, () => 0.5)).toBe(1000)
  expect(jitteredDelay(1000, () => 0.999999)).toBeLessThanOrEqual(1000 * (1 + SCHEDULE_JITTER))
})

test('the first run waits one interval, and the next is armed only after a run ends', async () => {
  const timer = manualTimer()
  let release: () => void = () => undefined
  let runs = 0
  startSchedule({
    run: () => {
      runs += 1
      return new Promise<void>((resolve) => {
        release = resolve
      })
    },
    onError: () => undefined,
    intervalMs: 1000,
    random: () => 0.5,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  })
  expect(runs).toBe(0)
  expect(timer.armed).toHaveLength(1)
  timer.fire()
  expect(runs).toBe(1)
  // Still running: no second timer, so no overlap.
  expect(timer.armed).toHaveLength(1)
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(timer.armed).toHaveLength(2)
})

test('a run that throws is reported and the schedule goes on', async () => {
  const timer = manualTimer()
  const errors: unknown[] = []
  startSchedule({
    run: async () => {
      throw new Error('boom')
    },
    onError: (error) => errors.push(error),
    intervalMs: 1000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  })
  timer.fire()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(errors).toHaveLength(1)
  expect(timer.armed).toHaveLength(2)
})

test('stop cancels the timer, waits for a run in flight, and arms nothing more', async () => {
  const timer = manualTimer()
  let release: () => void = () => undefined
  let finished = false
  const schedule = startSchedule({
    run: () =>
      new Promise<void>((resolve) => {
        release = () => {
          finished = true
          resolve()
        }
      }),
    onError: () => undefined,
    intervalMs: 1000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  })
  timer.fire()
  const stopped = schedule.stop()
  expect(timer.cleared()).toBe(1)
  expect(finished).toBe(false)
  release()
  await stopped
  expect(finished).toBe(true)
  expect(timer.armed).toHaveLength(1)
})
