import type { AGENT_TOOLS } from 'tula-closeline-contract'

/** The conversation a turn belongs to: a Call, a Chat or an Admin's try-it session. */
export type ConversationRef = { kind: 'call' | 'chat' | 'try'; id: string }

/** One passage a turn cites: the Document, its page (`null` when it has none) and the quoted text. */
export type TurnSource = { documentId: string; page: number | null; passage: string }

/** A turn to store: its 0-based index in the conversation is its idempotency key. */
export type NewAgentTurn = {
  index: number
  role: 'prospect' | 'agent'
  text: string
  deferred: boolean
  toolName: (typeof AGENT_TOOLS)[number] | null
  sources: readonly TurnSource[]
}

/** A stored turn. */
export type StoredAgentTurn = NewAgentTurn & { id: string; createdAt: string }

/** The most turns one `recent` call returns. */
export const MAX_RECENT_TURNS = 50

/**
 * Where the turns of Inbound Agent conversations are kept. Every method takes the Organization
 * first and reaches that Organization's rows only. A turn's index in its conversation is unique,
 * so storing the same index twice stores it once.
 */
export type AgentTurnStore = {
  /** The turn at `index`, with its sources, or `undefined`. */
  get: (
    organizationId: string,
    conversation: ConversationRef,
    index: number
  ) => Promise<StoredAgentTurn | undefined>
  /**
   * The latest `limit` turns (1 to {@link MAX_RECENT_TURNS}) whose index is below `before`, oldest
   * first, each with its sources.
   */
  recent: (
    organizationId: string,
    conversation: ConversationRef,
    before: number,
    limit: number
  ) => Promise<StoredAgentTurn[]>
  /**
   * The turns with an index from `from` to `to` (both included), oldest first, at most
   * {@link MAX_RECENT_TURNS}; a missing index is simply absent. Sources are not read.
   */
  range: (
    organizationId: string,
    conversation: ConversationRef,
    from: number,
    to: number
  ) => Promise<StoredAgentTurn[]>
  /**
   * Stores the turn and its sources together. When a turn already exists at that index nothing is
   * written and the stored one is returned with `created: false`, whatever the new one says.
   */
  append: (
    organizationId: string,
    conversation: ConversationRef,
    turn: NewAgentTurn
  ) => Promise<{ turn: StoredAgentTurn; created: boolean }>
}
