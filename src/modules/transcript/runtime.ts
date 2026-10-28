import type { TranscribeStream } from 'tula-closeline-kit'
import type { TurnTrack } from '~/ports/call-turn-store'

/** Why a Call's live Transcript stopped, as the stream names it. */
export type UnavailableReason = 'speech_to_text_failed' | 'stream_dropped'

/** The two speech-to-text streams of one Call and the writes still saving its turns. */
export type OpenTranscript = {
  streams: Partial<Record<TurnTrack, TranscribeStream>>
  saving: Partial<Record<TurnTrack, Promise<void>>>
}

/**
 * What the Copilot holds in this process: the open streams per Call and which Calls lost their
 * Transcript. shortcut: process memory, so one instance only and a restart forgets both; move the
 * unavailable flag to a Call column before running more than one instance.
 */
export type CopilotRuntime = {
  streams: Map<string, OpenTranscript>
  unavailable: Map<string, UnavailableReason>
  /** How often an open SSE stream looks for new turns, in milliseconds. */
  pollMs: number
}

/** The most Calls whose unavailable flag is remembered; the oldest is forgotten first. */
export const MAX_REMEMBERED_CALLS = 5_000

/** Builds an empty runtime. */
export function createCopilotRuntime(pollMs = 500): CopilotRuntime {
  return { streams: new Map(), unavailable: new Map(), pollMs }
}

/** Remembers that a Call lost its Transcript, forgetting the oldest Call beyond the bound. */
export function markUnavailable(
  runtime: CopilotRuntime,
  callId: string,
  reason: UnavailableReason
): void {
  runtime.unavailable.delete(callId)
  runtime.unavailable.set(callId, reason)
  const oldest = runtime.unavailable.keys().next().value
  if (runtime.unavailable.size > MAX_REMEMBERED_CALLS && oldest !== undefined) {
    runtime.unavailable.delete(oldest)
  }
}
