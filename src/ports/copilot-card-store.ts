import type { CopilotCard } from 'tula-closeline-contract'

/** A retrieval card: what a card is when it is first shown. */
export type SimilarMomentCard = Extract<CopilotCard, { kind: 'similar_moment' }>

/** What a new card holds; the store gives it its id, sequence and time. A `source` makes it a `document` card. */
export type NewCard = Pick<SimilarMomentCard, 'evidence' | 'citedMoments' | 'quotes'> & {
  shownAt: Date
  source?: Extract<CopilotCard, { kind: 'document' }>['source']
}

/** What the model composer turns a retrieval card into: the wording and the Moments it really used. */
export type Composed = Pick<SimilarMomentCard, 'citedMoments' | 'quotes'> &
  (
    | {
        kind: 'objection'
        objectionType: Extract<CopilotCard, { kind: 'objection' }>['objectionType']
        response: string
      }
    | { kind: 'next_step'; nextStep: string }
  )

/** The most cards one `list` call returns. */
export const MAX_CARD_PAGE = 60

/** What the throttle and the repeat check need to know about a Call's cards. */
export type CardTally = {
  /** Every card shown on the Call so far. */
  count: number
  /** The cards shown at or after the asked time, newest last. */
  recent: { shownAt: Date; citedMoments: SimilarMomentCard['citedMoments'] }[]
}

/**
 * Where the Copilot Cards of a Rep's Call are kept. Every method takes the Organization first and
 * reaches that Organization's rows only. A card's sequence on its Call is unique, so two writers
 * racing for the same one cannot both store it.
 */
export type CopilotCardStore = {
  /** Stores `card` under the Call's next sequence and returns it whole. */
  append: (organizationId: string, callId: string, card: NewCard) => Promise<CopilotCard>
  /** The cards after `afterSequence`, oldest first, at most `limit` (1 to {@link MAX_CARD_PAGE}). */
  list: (
    organizationId: string,
    callId: string,
    afterSequence: number,
    limit: number
  ) => Promise<CopilotCard[]>
  /**
   * Turns the Call's retrieval card `cardId` into the composed card, in place (same id, sequence and
   * time). It returns the card whole, or undefined when there is no such retrieval card (already
   * upgraded, or another Organization's), so a card is upgraded once.
   */
  upgrade: (
    organizationId: string,
    callId: string,
    cardId: string,
    composed: Composed
  ) => Promise<CopilotCard | undefined>
  /** How many cards the Call has, and those shown at or after `since`. */
  tally: (organizationId: string, callId: string, since: Date) => Promise<CardTally>
}
