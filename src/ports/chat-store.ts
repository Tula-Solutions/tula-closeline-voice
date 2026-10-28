/** A Chat as the service reads it: the session's row, never its token. */
export type StoredChat = {
  id: string
  state: 'open' | 'handed_off' | 'closed'
  sourceUrl: string
  prospectId: string | null
  inquiryId: string | null
  startedAt: string
  lastMessageAt: string
  expiresAt: string
  closedAt: string | null
}

/** What starting a Chat stores. */
export type NewChat = {
  id: string
  /** The SHA-256 of the session token; the token itself is never stored. */
  tokenHash: Uint8Array
  sourceUrl: string
  startedAt: Date
  expiresAt: Date
}

/** What a callback request in a Chat turns it into. */
export type NewChatInquiry = {
  prospectId: string
  wordingId: string
  wordingVersion: number
  sourceUrl: string
  /** Whether the visitor agreed to a phone callback. */
  agreed: boolean
  at: Date
}

/** The Chats of every Organization; the only way a module reaches `voice.chats`. */
export type ChatStore = {
  /** Stores a new Chat, or returns the one already stored for the same token hash (`created: false`). */
  start: (organizationId: string, chat: NewChat) => Promise<{ chat: StoredChat; created: boolean }>
  /** The Organization's Chat with this token hash, or undefined. Another Organization's is never found. */
  byTokenHash: (organizationId: string, tokenHash: Uint8Array) => Promise<StoredChat | undefined>
  /** Records that the visitor wrote at `at`. */
  touch: (organizationId: string, chatId: string, at: Date) => Promise<void>
  /**
   * Turns the Chat into an Inquiry linked to the Prospect, once: a second call returns the first
   * Inquiry's id and changes nothing.
   */
  becomeInquiry: (
    organizationId: string,
    chatId: string,
    inquiry: NewChatInquiry
  ) => Promise<{ inquiryId: string }>
}
