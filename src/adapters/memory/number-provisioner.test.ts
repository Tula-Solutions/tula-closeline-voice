import { describe, expect, test } from 'bun:test'
import {
  createMemoryNumberProvisioner,
  createRunningMemoryNumberProvisioner,
} from '~/adapters/memory/number-provisioner'

const request = { country: 'US', areaCode: '415' } as const
const signal = new AbortController().signal

describe('memory number provisioner', () => {
  test('numbers and provider ids are deterministic from the default start', async () => {
    const numbers = createMemoryNumberProvisioner()
    const first = await numbers.buy(request, signal)
    const second = await numbers.buy(request, signal)
    expect(first.number).toBe('+14155550001')
    expect(first.providerSid).toBe('mem_000001')
    expect(second.providerSid).toBe('mem_000002')
    expect(second.number).not.toBe(first.number)
  })

  test('a restarted service does not buy a number the previous run already stored', async () => {
    const stored = new Set<string>()
    const storedSids = new Set<string>()
    // Two draws stand in for two process starts; the second run starts elsewhere.
    for (const draw of [0.1, 0.3]) {
      const numbers = createRunningMemoryNumberProvisioner(() => draw)
      for (let i = 0; i < 5; i += 1) {
        const bought = await numbers.buy(request, signal)
        stored.add(bought.number)
        storedSids.add(bought.providerSid)
      }
    }
    expect(stored.size).toBe(10)
    expect(storedSids.size).toBe(10)
  })

  test('two running instances with different draws never collide on a first buy', async () => {
    const a = await createRunningMemoryNumberProvisioner(() => 0.2).buy(request, signal)
    const b = await createRunningMemoryNumberProvisioner(() => 0.7).buy(request, signal)
    expect(a.number).not.toBe(b.number)
    expect(a.providerSid).not.toBe(b.providerSid)
  })

  test('the subscriber part stays four digits and wraps past 9999', async () => {
    const numbers = createMemoryNumberProvisioner({ start: 9998 })
    const subscribers: string[] = []
    for (let i = 0; i < 3; i += 1) {
      subscribers.push((await numbers.buy(request, signal)).number.slice(-4))
    }
    expect(subscribers).toEqual(['9999', '0000', '0001'])
  })

  test('porting keeps the number and releasing records the provider id', async () => {
    const numbers = createMemoryNumberProvisioner()
    const ported = await numbers.port('+442071234567', signal)
    expect(ported).toMatchObject({ number: '+442071234567', country: 'GB', state: 'porting' })
    await numbers.release(ported.providerSid, signal)
    expect(numbers.released).toEqual([ported.providerSid])
  })

  test('every call rejects on an aborted signal and does nothing', async () => {
    const numbers = createMemoryNumberProvisioner()
    const aborted = AbortSignal.abort()
    await expect(numbers.buy(request, aborted)).rejects.toThrow()
    await expect(numbers.port('+14155550100', aborted)).rejects.toThrow()
    await expect(numbers.release('mem_000001', aborted)).rejects.toThrow()
    expect(numbers.released).toEqual([])
    expect((await numbers.buy(request, signal)).providerSid).toBe('mem_000001')
  })
})
