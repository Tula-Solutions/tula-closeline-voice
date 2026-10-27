import { formatId } from 'tula-closeline-contract'
import type {
  AgentTurnStore,
  ConversationRef,
  NewAgentTurn,
  StoredAgentTurn,
} from '~/ports/agent-turn-store'
import { MAX_RECENT_TURNS } from '~/ports/agent-turn-store'

const keyOf = (organizationId: string, c: ConversationRef) =>
  `${organizationId}\u0000${c.kind}\u0000${c.id}`

/** An in-memory {@link AgentTurnStore} for tests and local runs. */
export function createMemoryAgentTurnStore(now: () => Date = () => new Date()): AgentTurnStore {
  const byConversation = new Map<string, Map<number, StoredAgentTurn>>()
  return {
    async get(organizationId, conversation, index) {
      const found = byConversation.get(keyOf(organizationId, conversation))?.get(index)
      return found === undefined ? undefined : structuredClone(found)
    },
    async recent(organizationId, conversation, before, limit) {
      const size = Math.min(Math.max(limit, 1), MAX_RECENT_TURNS)
      const turns = [...(byConversation.get(keyOf(organizationId, conversation))?.values() ?? [])]
        .filter((turn) => turn.index < before)
        .sort((a, b) => a.index - b.index)
      return structuredClone(turns.slice(-size))
    },
    async range(organizationId, conversation, from, to) {
      const turns = [...(byConversation.get(keyOf(organizationId, conversation))?.values() ?? [])]
        .filter((turn) => turn.index >= from && turn.index <= to)
        .sort((a, b) => a.index - b.index)
      return structuredClone(turns.slice(0, MAX_RECENT_TURNS))
    },
    async append(organizationId, conversation, turn: NewAgentTurn) {
      const key = keyOf(organizationId, conversation)
      const turns = byConversation.get(key) ?? new Map<number, StoredAgentTurn>()
      byConversation.set(key, turns)
      const existing = turns.get(turn.index)
      if (existing !== undefined) {
        return { turn: structuredClone(existing), created: false }
      }
      const stored: StoredAgentTurn = {
        ...structuredClone(turn),
        id: formatId('trn', crypto.randomUUID()),
        createdAt: now().toISOString(),
      }
      turns.set(turn.index, stored)
      return { turn: structuredClone(stored), created: true }
    },
  }
}
