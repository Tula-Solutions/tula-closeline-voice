import type { TranscribeStream } from 'tula-closeline-kit'
import type { TurnTrack } from '~/ports/call-turn-store'

/** The two speech-to-text streams of one Call and the writes still saving its turns. */
export type OpenTranscript = {
  streams: Partial<Record<TurnTrack, TranscribeStream>>
  saving: Partial<Record<TurnTrack, Promise<void>>>
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
}

/** The default lifetime of one SSE stream: five minutes. */
export const DEFAULT_MAX_STREAM_MS = 300_000

/** Builds an empty runtime. */
export function createCopilotRuntime(
  pollMs = 500,
  maxStreamMs = DEFAULT_MAX_STREAM_MS
): CopilotRuntime {
  return { streams: new Map(), pollMs, maxStreamMs }
}
