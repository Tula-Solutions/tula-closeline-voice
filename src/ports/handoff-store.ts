import { type Handoff, handoffIdSchema, timestampSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The most Reps one Call is offered to; the table's `attempt` column allows 10. */
export const MAX_HANDOFF_ATTEMPTS = 5

/** Where the next page of Handoffs starts: the last one's request time and id. */
export const handoffCursorSchema = z.strictObject({
  requestedAt: timestampSchema,
  id: handoffIdSchema,
})

/** A position in the Handoff list. */
export type HandoffCursor = z.infer<typeof handoffCursorSchema>

/** What a Handoff ends as, when it ends: the Rep took the Call, or nobody could. */
export type HandoffResult = 'bridged' | 'abandoned' | 'booking_offered'

/** Where Handoffs of Agent Calls are kept. Every method names the Organization first. */
export type HandoffStore = {
  /**
   * Offers the Call to one Rep: a `pending` row for that attempt. `undefined` when the Call
   * already has a live (`pending` or `accepted`) Handoff.
   */
  offer: (
    organizationId: string,
    offer: {
      callId: string
      repMembershipId: string
      attempt: number
      reason: Handoff['reason']
      at: Date
    }
  ) => Promise<Handoff | undefined>
  /** One Handoff, or `undefined` when the Organization has none with that id. */
  get: (organizationId: string, id: Handoff['id']) => Promise<Handoff | undefined>
  /**
   * Handoffs newest first, at most `limit`. `repMembershipIds` limits them to those offered to
   * those Reps (`undefined` is every Handoff of the Organization, an empty list none).
   */
  list: (
    organizationId: string,
    query: {
      limit: number
      cursor?: HandoffCursor
      state?: Handoff['state']
      repMembershipIds?: readonly string[]
    }
  ) => Promise<Handoff[]>
  /** Every Handoff of the Call, oldest attempt first (at most the attempt limit). */
  forCall: (organizationId: string, callId: string) => Promise<Handoff[]>
  /** The offered Rep accepts or declines a `pending` Handoff; `undefined` when it is not theirs and pending. */
  answer: (
    organizationId: string,
    id: Handoff['id'],
    repMembershipId: string,
    answer: 'accepted' | 'declined',
    at: Date
  ) => Promise<Handoff | undefined>
  /** Moves a `pending` Handoff nobody answered to `timed_out`; `undefined` when it is no longer pending. */
  expire: (organizationId: string, id: Handoff['id']) => Promise<Handoff | undefined>
  /** Ends an `accepted` Handoff with its result; `undefined` when it is not `accepted`. */
  complete: (
    organizationId: string,
    id: Handoff['id'],
    result: HandoffResult,
    at: Date
  ) => Promise<Handoff | undefined>
  /** Records that no Rep could be reached: a `no_rep` row, already complete, with no Rep. */
  noRep: (
    organizationId: string,
    entry: { callId: string; reason: Handoff['reason']; attempt: number; at: Date }
  ) => Promise<Handoff>
}
