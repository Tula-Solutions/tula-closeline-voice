import {
  type CallTurnStore,
  MAX_TURN_PAGE,
  type StoredCallTurn,
  type TurnTrack,
} from '~/ports/call-turn-store'

/** Orders turns by start time, then track, then sequence. */
export const byTime = (a: StoredCallTurn, b: StoredCallTurn): number =>
  a.startMs - b.startMs || a.track.localeCompare(b.track) || a.sequence - b.sequence

/** An in-memory {@link CallTurnStore} for tests and local runs. */
export function createMemoryCallTurnStore(): CallTurnStore {
  const byCall = new Map<string, StoredCallTurn[]>()
  const keyOf = (organizationId: string, callId: string) => `${organizationId}\u0000${callId}`
  return {
    async append(organizationId, callId, turn) {
      const turns = byCall.get(keyOf(organizationId, callId)) ?? []
      byCall.set(keyOf(organizationId, callId), turns)
      const last = turns.filter((t) => t.track === turn.track).length
      const stored: StoredCallTurn = { ...turn, sequence: last + 1 }
      turns.push(stored)
      return { ...stored }
    },
    async list(organizationId, callId, cursor, limit) {
      const size = Math.min(Math.max(limit, 1), MAX_TURN_PAGE)
      const after = (track: TurnTrack) => cursor[track]
      return (byCall.get(keyOf(organizationId, callId)) ?? [])
        .filter((turn) => turn.sequence > after(turn.track))
        .sort(byTime)
        .slice(0, size)
        .map((turn) => ({ ...turn }))
    },
  }
}
