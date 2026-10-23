import type { NumberProvisioner } from '~/ports/number-provisioner'

/** The in-memory provisioner plus what a test asserts on. */
export type MemoryNumberProvisioner = NumberProvisioner & {
  /** Every provider id released, in order. */
  released: string[]
}

const DIALLING_CODES: Readonly<Record<string, string>> = { US: '1', CA: '1', GB: '44', DE: '49' }

const SUBSCRIBER_SPACE = 10_000

/** Where a provisioner's counter begins and how its provider ids are told apart from other runs. */
export type MemoryNumberProvisionerOptions = {
  /** The counter's first value; the subscriber digits are the counter modulo 10000. Default 0. */
  start?: number
  /** Put in every provider id so ids from different runs never meet. Default none. */
  runId?: string
}

/** A provisioner that invents numbers locally; it never talks to a provider. */
export function createMemoryNumberProvisioner(
  options: MemoryNumberProvisionerOptions = {}
): MemoryNumberProvisioner {
  let counter = options.start ?? 0
  const idPrefix = options.runId ? `mem_${options.runId}_` : 'mem_'
  const released: string[] = []
  const next = (): string => {
    counter += 1
    return `${idPrefix}${String(counter).padStart(6, '0')}`
  }

  return {
    released,
    async buy({ country, areaCode }) {
      const providerSid = next()
      const subscriber = String(counter % SUBSCRIBER_SPACE).padStart(4, '0')
      return {
        number: `+${DIALLING_CODES[country] ?? '1'}${areaCode ?? '415'}555${subscriber}`,
        country,
        providerSid,
        state: 'active',
      }
    },
    async port(number) {
      const country =
        Object.entries(DIALLING_CODES).find(([, code]) => number.startsWith(`+${code}`))?.[0] ??
        'US'
      return { number, country, providerSid: next(), state: 'porting' }
    },
    async release(providerSid) {
      released.push(providerSid)
    },
  }
}

/**
 * The provisioner for a running service: a random start and a random run id, because its Lines
 * outlive the process in Postgres while this counter does not. A restart then rarely meets a
 * stored number (about one in 10000 per stored number) and never meets a stored provider id.
 */
export function createRunningMemoryNumberProvisioner(
  random: () => number = Math.random
): MemoryNumberProvisioner {
  return createMemoryNumberProvisioner({
    start: Math.floor(random() * SUBSCRIBER_SPACE),
    runId: crypto.randomUUID().slice(0, 8),
  })
}
