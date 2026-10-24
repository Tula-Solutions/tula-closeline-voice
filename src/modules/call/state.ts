import type { VoiceCallState } from 'tula-closeline-contract'

/**
 * The edges of a Call's life. A Call walks ringing, connecting, disclosing, live, ended; any step
 * before `live` can end in failed, and a Call nobody picks up before the Disclosure is missed.
 * `ended`, `failed` and `missed` are final.
 */
export const CALL_EDGES: Readonly<Record<VoiceCallState, readonly VoiceCallState[]>> = {
  ringing: ['connecting', 'failed', 'missed'],
  connecting: ['disclosing', 'failed', 'missed'],
  disclosing: ['live', 'failed'],
  live: ['ended', 'failed'],
  ended: [],
  failed: [],
  missed: [],
}

/**
 * Whether a Call may move from one state to another. `live` and `ended` also need a stored
 * Disclosure version (ADR 0003): there is no setting that lets a Call go live without one.
 */
export function canTransition(
  from: VoiceCallState,
  to: VoiceCallState,
  disclosureWordingVersion: number | null
): boolean {
  if (!CALL_EDGES[from].includes(to)) {
    return false
  }
  return (to !== 'live' && to !== 'ended') || disclosureWordingVersion !== null
}
