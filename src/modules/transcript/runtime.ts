import type { SearchTurn } from 'tula-closeline-contract'
import type { TranscribeStream } from 'tula-closeline-kit'
import type { TurnTrack } from '~/ports/call-turn-store'

/** The two speech-to-text streams of one Call and the writes still saving its turns. */
export type OpenTranscript = {
  streams: Partial<Record<TurnTrack, TranscribeStream>>
  saving: Partial<Record<TurnTrack, Promise<void>>>
  /** The last few saved turns of both tracks, newest last: what a card search is built from. */
  window: SearchTurn[]
  /** Counts the Prospect turns heard; a card search whose number is no longer current is stale. */
  searchSeq: number
  /** The card searches still running, so a finishing Call or a test can wait for them. */
  carding: Set<Promise<void>>
}

/**
 * What one instance holds for the Calls whose media socket it serves: the open speech-to-text
 * streams, which live exactly as long as that socket. Nothing here is shared state; whether a
 * Transcript is unavailable is a column on the Call (`transcriptUnavailable`).
 */
export type CopilotRuntime = {
  streams: Map<string, OpenTranscript>
  /** How often an open SSE stream looks for new turns, in milliseconds. */
  pollMs: number
  /**
   * How long one SSE stream stays open before it ends and the client resumes with `Last-Event-ID`.
   * The token is checked when a stream opens, so this bounds how long a stream outlives it.
   */
  maxStreamMs: number
  /** How long a card's Moment search may take before it is dropped, in milliseconds. */
  cardSearchTimeoutMs: number
}

/** The default time a card's Moment search may take: 1.2 s. */
export const DEFAULT_CARD_SEARCH_TIMEOUT_MS = 1_200

/** The default lifetime of one SSE stream: five minutes. */
export const DEFAULT_MAX_STREAM_MS = 300_000

/** Builds an empty runtime. */
export function createCopilotRuntime(
  pollMs = 500,
  maxStreamMs = DEFAULT_MAX_STREAM_MS,
  cardSearchTimeoutMs = DEFAULT_CARD_SEARCH_TIMEOUT_MS
): CopilotRuntime {
  return { streams: new Map(), pollMs, maxStreamMs, cardSearchTimeoutMs }
}
