import type { TtsAudioChunk, TtsPort } from 'tula-closeline-kit'

/** What an Agent speaks with: the voice engine and the registry of live media sockets. */
export type AgentAudio = {
  tts: TtsPort
  /** The audio leg of one Call, which receives the Agent's speech in order. */
  sinkFor: (callId: string) => (chunk: TtsAudioChunk) => void
  /** Routes a Call's speech to its live media socket; false when another socket already has it. */
  attach: (callId: string, writer: (chunk: TtsAudioChunk) => void) => boolean
  /** Stops routing a Call's speech to `writer`, when its media socket is gone. */
  detach: (callId: string, writer: (chunk: TtsAudioChunk) => void) => void
}

/**
 * Builds the Agent's audio over `tts`. The registry is this process's own: a Call's one live socket
 * is here too, so speech for a Call with no socket here is dropped, never queued.
 */
export function createAgentAudio(tts: TtsPort): AgentAudio {
  const writers = new Map<string, (chunk: TtsAudioChunk) => void>()
  return {
    tts,
    sinkFor: (callId) => (chunk) => writers.get(callId)?.(chunk),
    attach: (callId, writer) => {
      if (writers.has(callId)) {
        return false
      }
      writers.set(callId, writer)
      return true
    },
    detach: (callId, writer) => {
      if (writers.get(callId) === writer) {
        writers.delete(callId)
      }
    },
  }
}
