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
  /**
   * Whether each dialled Call still ringing was placed with the Copilot on. Taken (read and
   * removed) when the Prospect answers. shortcut: process memory, so a restart while a Call rings
   * fails that Call closed; move it to a Call column before running more than one instance.
   */
  dialed: Map<string, boolean>
  /** How often an open SSE stream looks for new turns, in milliseconds. */
  pollMs: number
}

/** The most Calls whose unavailable flag is remembered; the oldest is forgotten first. */
export const MAX_REMEMBERED_CALLS = 5_000

/** Builds an empty runtime. */
export function createCopilotRuntime(pollMs = 500): CopilotRuntime {
  return { streams: new Map(), unavailable: new Map(), dialed: new Map(), pollMs }
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

/** Remembers whether a dialled Call has the Copilot on, forgetting the oldest beyond the bound. */
export function rememberDialed(runtime: CopilotRuntime, callId: string, copilot: boolean): void {
  runtime.dialed.set(callId, copilot)
  const oldest = runtime.dialed.keys().next().value
  if (runtime.dialed.size > MAX_REMEMBERED_CALLS && oldest !== undefined) {
    runtime.dialed.delete(oldest)
  }
}

/** Reads and forgets whether a dialled Call has the Copilot on; `undefined` when not remembered. */
export function takeDialed(runtime: CopilotRuntime, callId: string): boolean | undefined {
  const copilot = runtime.dialed.get(callId)
  runtime.dialed.delete(callId)
  return copilot
}
