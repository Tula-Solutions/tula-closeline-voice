import { and, eq } from 'drizzle-orm'
import { formatId } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceChats, voiceInquiries } from 'tula-closeline-db/schema'
import type { ChatStore, StoredChat } from '~/ports/chat-store'

type Row = typeof voiceChats.$inferSelect

const toStored = (row: Row): StoredChat => ({
  id: row.id,
  state: row.state,
  sourceUrl: row.sourceUrl,
  prospectId: row.prospectId,
  inquiryId: row.inquiryId,
  startedAt: row.startedAt.toISOString(),
  lastMessageAt: row.lastMessageAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  closedAt: row.closedAt?.toISOString() ?? null,
})

/** A {@link ChatStore} over `voice.chats` and `voice.inquiries`, always inside the Organization's transaction. */
export function createPostgresChatStore(db: Database): ChatStore {
  const byHash = (organizationId: string, tokenHash: Uint8Array) =>
    and(
      eq(voiceChats.organizationId, organizationId),
      eq(voiceChats.sessionTokenHash, Buffer.from(tokenHash))
    )
  return {
    async start(organizationId, chat) {
      return withOrganization(db, organizationId, async (tx) => {
        const inserted = await tx
          .insert(voiceChats)
          .values({
            id: chat.id,
            organizationId,
            sessionTokenHash: Buffer.from(chat.tokenHash),
            sourceUrl: chat.sourceUrl,
            startedAt: chat.startedAt,
            lastMessageAt: chat.startedAt,
            expiresAt: chat.expiresAt,
          })
          .onConflictDoNothing()
          .returning()
        if (inserted[0] !== undefined) {
          return { chat: toStored(inserted[0]), created: true }
        }
        const [existing] = await tx
          .select()
          .from(voiceChats)
          .where(byHash(organizationId, chat.tokenHash))
        if (existing === undefined) {
          throw new Error('A Chat that conflicted on its token could not be read back')
        }
        return { chat: toStored(existing), created: false }
      })
    },
    async byTokenHash(organizationId, tokenHash) {
      return withOrganization(db, organizationId, async (tx) => {
        const [row] = await tx.select().from(voiceChats).where(byHash(organizationId, tokenHash))
        return row === undefined ? undefined : toStored(row)
      })
    },
    async touch(organizationId, chatId, at) {
      await withOrganization(db, organizationId, (tx) =>
        tx
          .update(voiceChats)
          .set({ lastMessageAt: at })
          .where(and(eq(voiceChats.organizationId, organizationId), eq(voiceChats.id, chatId)))
      )
    },
    async becomeInquiry(organizationId, chatId, inquiry) {
      return withOrganization(db, organizationId, async (tx) => {
        await tx
          .insert(voiceInquiries)
          .values({
            id: formatId('inq', crypto.randomUUID()),
            organizationId,
            idempotencyKey: `chat:${chatId}`,
            source: 'chat',
            prospectId: inquiry.prospectId,
            chatId,
            consentWordingId: inquiry.wordingId,
            consentWordingVersion: inquiry.wordingVersion,
            consentSourceUrl: inquiry.sourceUrl,
            consentPhoneGranted: inquiry.agreed,
            callbackState: inquiry.agreed ? 'pending' : 'skipped',
            callbackSkipReason: inquiry.agreed ? null : 'no_consent',
            receivedAt: inquiry.at,
            updatedAt: inquiry.at,
          })
          .onConflictDoNothing()
        const [row] = await tx
          .select({ id: voiceInquiries.id, prospectId: voiceInquiries.prospectId })
          .from(voiceInquiries)
          .where(
            and(
              eq(voiceInquiries.organizationId, organizationId),
              eq(voiceInquiries.chatId, chatId)
            )
          )
        if (row === undefined) {
          throw new Error('An Inquiry that conflicted on its Chat could not be read back')
        }
        await tx
          .update(voiceChats)
          .set({ prospectId: row.prospectId, inquiryId: row.id })
          .where(and(eq(voiceChats.organizationId, organizationId), eq(voiceChats.id, chatId)))
        return { inquiryId: row.id }
      })
    },
  }
}
