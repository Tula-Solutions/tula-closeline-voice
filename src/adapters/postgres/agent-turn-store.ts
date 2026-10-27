import { and, desc, eq, inArray, lt, type SQL } from 'drizzle-orm'
import { AGENT_TOOLS, formatId } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceAgentTurnSources, voiceAgentTurns } from 'tula-closeline-db/schema'
import type {
  AgentTurnStore,
  ConversationRef,
  NewAgentTurn,
  StoredAgentTurn,
  TurnSource,
} from '~/ports/agent-turn-store'
import { MAX_RECENT_TURNS } from '~/ports/agent-turn-store'

type Row = typeof voiceAgentTurns.$inferSelect
type SourceRow = typeof voiceAgentTurnSources.$inferSelect

/** The column that holds the conversation id, by kind. */
function conversationIs(ref: ConversationRef): SQL {
  switch (ref.kind) {
    case 'call':
      return eq(voiceAgentTurns.callId, ref.id)
    case 'chat':
      return eq(voiceAgentTurns.chatId, ref.id)
    case 'try':
      return eq(voiceAgentTurns.trySessionId, ref.id)
  }
}

/** The three nullable conversation columns for a new row: exactly one is set. */
function conversationColumns(ref: ConversationRef) {
  return {
    callId: ref.kind === 'call' ? ref.id : null,
    chatId: ref.kind === 'chat' ? ref.id : null,
    trySessionId: ref.kind === 'try' ? ref.id : null,
  }
}

const toolOf = (name: string | null): StoredAgentTurn['toolName'] =>
  AGENT_TOOLS.find((tool) => tool === name) ?? null

function toStored(row: Row, sources: readonly SourceRow[]): StoredAgentTurn {
  return {
    id: row.id,
    index: row.turnIndex,
    role: row.role === 'agent' ? 'agent' : 'prospect',
    text: row.text,
    deferred: row.deferred,
    toolName: toolOf(row.toolName),
    sources: sources
      .filter((source) => source.turnId === row.id)
      .sort((a, b) => a.position - b.position)
      .map(
        (source): TurnSource => ({
          documentId: source.documentId,
          page: source.page,
          passage: source.passage,
        })
      ),
    createdAt: row.createdAt.toISOString(),
  }
}

/** An {@link AgentTurnStore} over `voice.agent_turns` and `voice.agent_turn_sources`. */
export function createPostgresAgentTurnStore(db: Database): AgentTurnStore {
  return {
    async get(organizationId, conversation, index) {
      return withOrganization(db, organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(voiceAgentTurns)
          .where(
            and(
              eq(voiceAgentTurns.organizationId, organizationId),
              conversationIs(conversation),
              eq(voiceAgentTurns.turnIndex, index)
            )
          )
          .limit(1)
        if (row === undefined) {
          return undefined
        }
        const sources = await tx
          .select()
          .from(voiceAgentTurnSources)
          .where(
            and(
              eq(voiceAgentTurnSources.organizationId, organizationId),
              eq(voiceAgentTurnSources.turnId, row.id)
            )
          )
        return toStored(row, sources)
      })
    },

    async recent(organizationId, conversation, before, limit) {
      const size = Math.min(Math.max(limit, 1), MAX_RECENT_TURNS)
      return withOrganization(db, organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(voiceAgentTurns)
          .where(
            and(
              eq(voiceAgentTurns.organizationId, organizationId),
              conversationIs(conversation),
              lt(voiceAgentTurns.turnIndex, before)
            )
          )
          .orderBy(desc(voiceAgentTurns.turnIndex))
          .limit(size)
        const latest = rows.reverse()
        if (latest.length === 0) {
          return []
        }
        const sources = await tx
          .select()
          .from(voiceAgentTurnSources)
          .where(
            and(
              eq(voiceAgentTurnSources.organizationId, organizationId),
              inArray(
                voiceAgentTurnSources.turnId,
                latest.map((row) => row.id)
              )
            )
          )
        return latest.map((row) => toStored(row, sources))
      })
    },

    async append(organizationId, conversation, turn: NewAgentTurn) {
      return withOrganization(db, organizationId, async (tx) => {
        const inserted = await tx
          .insert(voiceAgentTurns)
          .values({
            id: formatId('trn', crypto.randomUUID()),
            organizationId,
            ...conversationColumns(conversation),
            turnIndex: turn.index,
            role: turn.role,
            text: turn.text,
            deferred: turn.deferred,
            toolName: turn.toolName,
          })
          .onConflictDoNothing()
          .returning()
        const [row] = inserted
        if (row === undefined) {
          const [existing] = await tx
            .select()
            .from(voiceAgentTurns)
            .where(
              and(
                eq(voiceAgentTurns.organizationId, organizationId),
                conversationIs(conversation),
                eq(voiceAgentTurns.turnIndex, turn.index)
              )
            )
            .limit(1)
          if (existing === undefined) {
            throw new Error('agent turn vanished after a conflict')
          }
          const sources = await tx
            .select()
            .from(voiceAgentTurnSources)
            .where(
              and(
                eq(voiceAgentTurnSources.organizationId, organizationId),
                eq(voiceAgentTurnSources.turnId, existing.id)
              )
            )
          return { turn: toStored(existing, sources), created: false }
        }
        const sourceRows =
          turn.sources.length === 0
            ? []
            : await tx
                .insert(voiceAgentTurnSources)
                .values(
                  turn.sources.map((source, position) => ({
                    organizationId,
                    turnId: row.id,
                    position,
                    documentId: source.documentId,
                    page: source.page,
                    passage: source.passage,
                  }))
                )
                .returning()
        return { turn: toStored(row, sourceRows), created: true }
      })
    },
  }
}
