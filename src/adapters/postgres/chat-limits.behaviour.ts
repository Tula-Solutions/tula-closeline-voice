import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { ChatRateLimiter } from '~/ports/chat-limits'

const org = (): string => formatId('org', crypto.randomUUID())
const hash = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))
const NOW = new Date('2026-01-01T00:00:10Z')

/** The behaviour every {@link ChatRateLimiter} must show, run against each adapter. */
export function chatRateLimiterBehaviour(name: string, make: () => ChatRateLimiter): void {
  describe(`ChatRateLimiter (${name})`, () => {
    test('allows up to the limit in a minute and refuses the next', async () => {
      const limiter = make()
      const [organizationId, key] = [org(), hash()]
      for (let i = 0; i < 3; i += 1) {
        expect(await limiter.hit(organizationId, key, NOW, 3)).toBe(true)
      }
      expect(await limiter.hit(organizationId, key, NOW, 3)).toBe(false)
    })

    test('the next minute starts a fresh count', async () => {
      const limiter = make()
      const [organizationId, key] = [org(), hash()]
      await limiter.hit(organizationId, key, NOW, 1)
      expect(await limiter.hit(organizationId, key, NOW, 1)).toBe(false)
      expect(await limiter.hit(organizationId, key, new Date(NOW.getTime() + 60_000), 1)).toBe(true)
    })

    test('keys and Organizations count apart', async () => {
      const limiter = make()
      const [a, b, key] = [org(), org(), hash()]
      await limiter.hit(a, key, NOW, 1)
      expect(await limiter.hit(a, hash(), NOW, 1)).toBe(true)
      expect(await limiter.hit(b, key, NOW, 1)).toBe(true)
    })

    test('concurrent hits are counted exactly', async () => {
      const limiter = make()
      const [organizationId, key] = [org(), hash()]
      const results = await Promise.all(
        Array.from({ length: 12 }, () => limiter.hit(organizationId, key, NOW, 5))
      )
      expect(results.filter(Boolean)).toHaveLength(5)
    })
  })
}
