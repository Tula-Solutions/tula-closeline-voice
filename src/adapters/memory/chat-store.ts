import { formatId } from 'tula-closeline-contract'
import type { ChatStore, StoredChat } from '~/ports/chat-store'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** An in-memory {@link ChatStore} for tests and local runs; every read is scoped by Organization. */
export function createMemoryChatStore(): ChatStore {
  const chats = new Map<string, Map<string, StoredChat & { tokenHash: string }>>()
  const inquiries = new Map<string, string>()
  const rowsOf = (org: string) => {
    let rows = chats.get(org)
    if (rows === undefined) {
      rows = new Map()
      chats.set(org, rows)
    }
    return rows
  }
  const view = ({ tokenHash: _, ...chat }: StoredChat & { tokenHash: string }): StoredChat => chat
  return {
    async start(org, chat) {
      const rows = rowsOf(org)
      const hash = hex(chat.tokenHash)
      const existing = [...rows.values()].find((row) => row.tokenHash === hash)
      if (existing !== undefined) {
        return { chat: view(existing), created: false }
      }
      const stored = {
        id: chat.id,
        state: 'open' as const,
        sourceUrl: chat.sourceUrl,
        prospectId: null,
        inquiryId: null,
        startedAt: chat.startedAt.toISOString(),
        lastMessageAt: chat.startedAt.toISOString(),
        expiresAt: chat.expiresAt.toISOString(),
        closedAt: null,
        tokenHash: hash,
      }
      rows.set(chat.id, stored)
      return { chat: view(stored), created: true }
    },
    async byTokenHash(org, tokenHash) {
      const found = [...rowsOf(org).values()].find((row) => row.tokenHash === hex(tokenHash))
      return found === undefined ? undefined : view(found)
    },
    async touch(org, chatId, at) {
      const row = rowsOf(org).get(chatId)
      if (row !== undefined) {
        row.lastMessageAt = at.toISOString()
      }
    },
    async becomeInquiry(org, chatId, inquiry) {
      const row = rowsOf(org).get(chatId)
      if (row === undefined) {
        throw new Error('the Chat does not exist')
      }
      const key = `${org}\u0000${chatId}`
      const inquiryId = inquiries.get(key) ?? formatId('inq', crypto.randomUUID())
      inquiries.set(key, inquiryId)
      row.prospectId ??= inquiry.prospectId
      row.inquiryId = inquiryId
      return { inquiryId }
    },
  }
}
