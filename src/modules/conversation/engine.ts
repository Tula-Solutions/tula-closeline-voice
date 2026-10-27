import {
  AGENT_TOOLS,
  ERRORS,
  MAX_SEARCH_TEXT_CHARACTERS,
  MAX_SEARCH_TURNS,
  type OrganizationId,
  type SearchTurn,
} from 'tula-closeline-contract'
import { LlmError, type LlmUsage } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Agent from '~/modules/agent-settings/service'
import type { StoredAgentTurn, TurnSource } from '~/ports/agent-turn-store'
import { buildPrompt, type Passage } from './prompt'
import { type ConverseInput, converseInputSchema, modelReplySchema, type ToolCall } from './schema'

/** What the engine needs from the container. */
export type ConversationDeps = Pick<
  Container,
  'agentSettings' | 'turns' | 'evidence' | 'llm' | 'logger'
>

/** The Agent is deferring when fewer than this many passages reach the score minimum. */
export const MIN_EVIDENCE_PASSAGES = 1

/**
 * The lowest similarity a Document passage may have and still count as evidence.
 * shortcut: 0.5 is a guess, not measured; tune it against real Playbook scores once the Agent can search.
 */
export const MIN_EVIDENCE_SCORE = 0.5

/** The most passages put in front of the model. */
export const MAX_PASSAGES = 5

/** The most Moments shown to the model as wording examples. */
export const MAX_WORDING_EXAMPLES = 3

/** The most earlier turns put in front of the model. */
export const HISTORY_TURNS = 10

/** The longest the model may take for one reply, in milliseconds. */
export const REPLY_TIMEOUT_MS = 10_000

/** The most tokens the model may write for one reply. */
export const REPLY_MAX_OUTPUT_TOKENS = 700

/** What the Agent says when it cannot answer from the Organization's Documents. */
export const DEFERRAL_REPLY =
  "I don't have a reliable answer to that. I'd rather not guess, so would you like one of our Reps to follow up with you?"

/** The longest quote kept with a stored source. */
const MAX_PASSAGE_QUOTE = 512

/** What the Agent stores when a Prospect cut it off before it said a word. */
export const UNSPOKEN_PLACEHOLDER = '…'

/** What speaking the reply produced: the words that were heard and what hearing, thinking and speaking cost. */
export type SpokenReply = { spoken: string; costMicroCents: number }

/** Optional behaviour of {@link converse} for a spoken conversation. */
export type ConverseOptions = {
  /**
   * Speaks the reply aloud. The Agent turn then stores only what it returns as `spoken`, never the
   * unspoken rest, and adds `costMicroCents` to the Call in the same step. Not called on a replay.
   */
  speak?: (generated: { reply: string; usage: LlmUsage }) => Promise<SpokenReply>
}

/** What one exchange produced. */
export type ConverseResult = {
  /** The Agent's reply text. */
  reply: string
  /** The Documents the reply relies on; empty for a deferral. */
  sources: TurnSource[]
  /** True when the Agent did not answer and offered a Rep. */
  deferred: boolean
  /** The one validated tool call to carry out, or `null`; always `null` on a replay. */
  toolCall: ToolCall | null
  /** True when this exchange was already stored and nothing was generated. */
  replayed: boolean
  /** The stored Prospect turn. */
  prospectTurn: StoredAgentTurn
  /** The stored Agent turn. */
  agentTurn: StoredAgentTurn
  /** The Call's cost in micro-cents after this exchange; `null` when none was added. */
  callCostMicroCents: number | null
}

/** Search turns from the latest turns, newest first within the character budget, oldest first out. */
function searchTurnsOf(turns: readonly Pick<StoredAgentTurn, 'role' | 'text'>[]): SearchTurn[] {
  const picked: SearchTurn[] = []
  let budget = MAX_SEARCH_TEXT_CHARACTERS
  for (const turn of turns.slice(-MAX_SEARCH_TURNS).reverse()) {
    if (budget <= 0) {
      break
    }
    const text = [...turn.text].slice(0, budget).join('').trim()
    if (text === '') {
      continue
    }
    budget -= [...text].length
    picked.unshift({ role: turn.role === 'agent' ? 'rep' : 'prospect', text })
  }
  return picked
}

/** Checks the model's reply against the passages it was given; the reason it fails, if it does. */
function sourcesOf(labels: readonly string[], passages: readonly Passage[]): Passage[] | 'unknown' {
  const byLabel = new Map(passages.map((passage) => [passage.label, passage]))
  const chosen: Passage[] = []
  for (const label of new Set(labels)) {
    const passage = byLabel.get(label)
    if (passage === undefined) {
      return 'unknown'
    }
    chosen.push(passage)
  }
  return chosen
}

const quote = (snippet: string): string => [...snippet].slice(0, MAX_PASSAGE_QUOTE).join('')

type Generated = {
  reply: string
  sources: TurnSource[]
  deferred: boolean
  toolCall: ToolCall | null
  usage: LlmUsage
}

const NO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 }

const deferral = (usage: LlmUsage = NO_USAGE): Generated => ({
  reply: DEFERRAL_REPLY,
  sources: [],
  deferred: true,
  toolCall: null,
  usage,
})

/**
 * Handles one Prospect message in text mode: refuses when the Agent is paused, finds the
 * Organization's own evidence, has the model write a structured reply, checks it, and stores both
 * turns. The tool call in the result is only validated, never run. Storing is idempotent on
 * `turnIndex`: a retry returns what was stored and asks the model nothing.
 */
export async function converse(
  deps: ConversationDeps,
  input: ConverseInput,
  options: ConverseOptions = {}
): Promise<ConverseResult> {
  const parsed = converseInputSchema.safeParse(input)
  if (!parsed.success) {
    throw domainError(ERRORS['request.invalid'])
  }
  const { organizationId, conversation, turnIndex, text } = parsed.data
  await Agent.assertNotPaused(deps, organizationId)

  const stored = await deps.turns.get(organizationId, conversation, turnIndex + 1)
  if (stored !== undefined) {
    const prospectTurn = await deps.turns.get(organizationId, conversation, turnIndex)
    if (prospectTurn !== undefined) {
      return {
        reply: stored.text,
        sources: [...stored.sources],
        deferred: stored.deferred,
        toolCall: null,
        replayed: true,
        prospectTurn,
        agentTurn: stored,
        callCostMicroCents: null,
      }
    }
  }

  const history = await deps.turns.recent(organizationId, conversation, turnIndex, HISTORY_TURNS)
  // The first message stored for this index is the one answered, whatever a retry sends.
  const { turn: prospectTurn } = await deps.turns.append(organizationId, conversation, {
    index: turnIndex,
    role: 'prospect',
    text,
    deferred: false,
    toolName: null,
    sources: [],
  })

  const generated = await generate(deps, organizationId, history, prospectTurn.text)
  const spoken =
    options.speak === undefined
      ? undefined
      : await options.speak({ reply: generated.reply, usage: generated.usage })
  const {
    turn: agentTurn,
    created,
    callCostMicroCents,
  } = await deps.turns.append(
    organizationId,
    conversation,
    {
      index: turnIndex + 1,
      role: 'agent',
      text: spoken === undefined ? generated.reply : spoken.spoken || UNSPOKEN_PLACEHOLDER,
      deferred: generated.deferred,
      toolName: generated.toolCall?.name ?? null,
      sources: generated.sources,
    },
    spoken?.costMicroCents
  )
  // A concurrent retry stored its reply first: this one wins nothing and must not run its tool.
  return {
    reply: agentTurn.text,
    sources: [...agentTurn.sources],
    deferred: agentTurn.deferred,
    toolCall: created ? generated.toolCall : null,
    replayed: !created,
    prospectTurn,
    agentTurn,
    callCostMicroCents,
  }
}

/** Retrieves evidence and asks the model; anything unacceptable becomes a deferral. */
async function generate(
  deps: ConversationDeps,
  organizationId: OrganizationId | string,
  history: readonly StoredAgentTurn[],
  text: string
): Promise<Generated> {
  const found = await deps.evidence.search(
    organizationId,
    searchTurnsOf([...history, { role: 'prospect', text }]),
    MAX_PASSAGES
  )
  const passages: Passage[] = found.documents
    .filter((match) => match.snippet.trim() !== '' && match.score >= MIN_EVIDENCE_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PASSAGES)
    .map((match, position) => ({
      label: `P${position + 1}`,
      documentId: match.documentId,
      fileName: match.fileName,
      page: match.page,
      snippet: match.snippet,
    }))
  if (passages.length < MIN_EVIDENCE_PASSAGES) {
    return deferral()
  }

  const { system, messages } = buildPrompt({
    history,
    text,
    passages,
    examples: found.moments.slice(0, MAX_WORDING_EXAMPLES),
  })
  let reply: ReturnType<typeof modelReplySchema.parse>
  let usage = NO_USAGE
  try {
    const completion = await deps.llm.complete({
      organizationId: organizationId as OrganizationId,
      tier: 'fast',
      system,
      messages,
      schema: modelReplySchema,
      schemaName: 'agent_reply',
      timeoutMs: REPLY_TIMEOUT_MS,
      maxOutputTokens: REPLY_MAX_OUTPUT_TOKENS,
    })
    reply = completion.value
    usage = completion.usage
  } catch (error) {
    if (error instanceof LlmError && error.code === 'llm.invalid_output') {
      // Includes a tool outside the closed set or arguments of the wrong shape.
      deps.logger.warn('agent reply rejected', { reason: 'invalid_output' })
      return deferral()
    }
    throw error
  }

  if (reply.toolCall !== null && !AGENT_TOOLS.some((tool) => tool === reply.toolCall?.name)) {
    deps.logger.warn('agent reply rejected', { reason: 'tool_not_allowed' })
    return deferral(usage)
  }
  if (reply.deferred) {
    return { reply: reply.reply, sources: [], deferred: true, toolCall: reply.toolCall, usage }
  }
  const cited = sourcesOf(reply.sources, passages)
  if (cited === 'unknown' || cited.length === 0) {
    deps.logger.warn('agent reply rejected', {
      reason: cited === 'unknown' ? 'unknown_source' : 'no_source',
    })
    return deferral(usage)
  }
  return {
    reply: reply.reply,
    sources: cited.map((passage) => ({
      documentId: passage.documentId,
      page: passage.page,
      passage: quote(passage.snippet),
    })),
    deferred: false,
    toolCall: reply.toolCall,
    usage,
  }
}
