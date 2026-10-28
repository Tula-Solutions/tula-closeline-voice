/** The side of a Call a Transcript turn was spoken on. */
export type TurnTrack = 'rep' | 'prospect'

/** A final turn to store; its sequence on the track is chosen by the store. */
export type NewCallTurn = { track: TurnTrack; text: string; startMs: number; endMs: number }

/** A stored turn. The sequence counts a track's turns from 1. */
export type StoredCallTurn = NewCallTurn & { sequence: number }

/** The most turns one `list` call returns. */
export const MAX_TURN_PAGE = 100

/** How far a reader has got: the last sequence it has seen on each track (0 for none). */
export type TurnCursor = { rep: number; prospect: number }

/**
 * Where the final turns of a Rep's Call are kept. Every method takes the Organization first and
 * reaches that Organization's rows only. A turn's sequence on its track is unique, so a retried
 * write of the same turn stores it once.
 */
export type CallTurnStore = {
  /** Stores `turn` under the next sequence on its track and returns it. */
  append: (organizationId: string, callId: string, turn: NewCallTurn) => Promise<StoredCallTurn>
  /**
   * The turns after `cursor`, in time order, at most `limit` (1 to {@link MAX_TURN_PAGE}). Never
   * skips one: every turn after the cursor on a track comes before any later one on that track.
   */
  list: (
    organizationId: string,
    callId: string,
    cursor: TurnCursor,
    limit: number
  ) => Promise<StoredCallTurn[]>
}
