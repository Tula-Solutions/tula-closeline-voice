import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { ChatStore, NewChat } from '~/ports/chat-store'

const org = (): string => formatId('org', crypto.randomUUID())
const newChat = (over: Partial<NewChat> = {}): NewChat => {
  const startedAt = new Date('2026-01-01T00:00:00Z')
  return {
    id: formatId('cht', crypto.randomUUID()),
    tokenHash: crypto.getRandomValues(new Uint8Array(32)),
    sourceUrl: 'https://acme.example/pricing',
    startedAt,
    expiresAt: new Date(startedAt.getTime() + 3_600_000),
    ...over,
  }
}
const inquiry = (prospectId = formatId('prs', crypto.randomUUID())) => ({
  prospectId,
  wordingId: formatId('cwd', crypto.randomUUID()),
  wordingVersion: 3,
  sourceUrl: 'https://acme.example/pricing',
  agreed: true,
  at: new Date('2026-01-01T00:05:00Z'),
})

/** The behaviour every {@link ChatStore} must show, run against each adapter. */
export function chatStoreBehaviour(name: string, make: () => ChatStore): void {
  describe(`ChatStore (${name})`, () => {
    test('stores a Chat once per token hash and finds it by that hash', async () => {
      const store = make()
      const a = org()
      const chat = newChat()
      const first = await store.start(a, chat)
      expect(first.created).toBe(true)
      const again = await store.start(a, { ...chat, id: formatId('cht', crypto.randomUUID()) })
      expect(again).toEqual({ chat: first.chat, created: false })
      expect(await store.byTokenHash(a, chat.tokenHash)).toEqual(first.chat)
    })

    test("never finds another Organization's Chat by its hash", async () => {
      const store = make()
      const chat = newChat()
      await store.start(org(), chat)
      expect(await store.byTokenHash(org(), chat.tokenHash)).toBeUndefined()
    })

    test('turns a Chat into one Inquiry, however often it is asked', async () => {
      const store = make()
      const a = org()
      const chat = newChat()
      await store.start(a, chat)
      const first = await store.becomeInquiry(a, chat.id, inquiry())
      const again = await store.becomeInquiry(a, chat.id, inquiry())
      expect(again).toEqual(first)
      const found = await store.byTokenHash(a, chat.tokenHash)
      expect(found?.inquiryId).toBe(first.inquiryId)
      expect(found?.prospectId).not.toBeNull()
    })

    test('records a callback request that was not agreed to as skipped, not pending', async () => {
      const store = make()
      const a = org()
      const chat = newChat()
      await store.start(a, chat)
      const { inquiryId } = await store.becomeInquiry(a, chat.id, { ...inquiry(), agreed: false })
      expect(inquiryId).toMatch(/^inq_/)
    })
  })
}
