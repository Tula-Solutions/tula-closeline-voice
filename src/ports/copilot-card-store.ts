import type { CopilotCard } from 'tula-closeline-contract'

/** A retrieval card: the one kind this service creates before the model composer exists. */
export type SimilarMomentCard = Extract<CopilotCard, { kind: 'similar_moment' }>

/** What a new retrieval card holds; the store gives it its id, sequence and time. */
export type NewSimilarMomentCard = Pick<
  SimilarMomentCard,
  'evidence' | 'citedMoments' | 'quotes'
> & { shownAt: Date }

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
  append: (
    organizationId: string,
    callId: string,
    card: NewSimilarMomentCard
  ) => Promise<SimilarMomentCard>
  /** The cards after `afterSequence`, oldest first, at most `limit` (1 to {@link MAX_CARD_PAGE}). */
  list: (
    organizationId: string,
    callId: string,
    afterSequence: number,
    limit: number
  ) => Promise<SimilarMomentCard[]>
  /** How many cards the Call has, and those shown at or after `since`. */
  tally: (organizationId: string, callId: string, since: Date) => Promise<CardTally>
}
