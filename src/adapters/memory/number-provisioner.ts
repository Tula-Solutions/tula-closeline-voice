import type { NumberProvisioner } from '~/ports/number-provisioner'

/** The in-memory provisioner plus what a test asserts on. */
export type MemoryNumberProvisioner = NumberProvisioner & {
  /** Every provider id released, in order. */
  released: string[]
}

const DIALLING_CODES: Readonly<Record<string, string>> = { US: '1', CA: '1', GB: '44', DE: '49' }

/** A provisioner that invents numbers locally; it never talks to a provider. */
export function createMemoryNumberProvisioner(): MemoryNumberProvisioner {
  let counter = 0
  const released: string[] = []
  const next = (): string => {
    counter += 1
    return `mem_${String(counter).padStart(6, '0')}`
  }

  return {
    released,
    async buy({ country, areaCode }) {
      const providerSid = next()
      const subscriber = String(counter).padStart(4, '0')
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
