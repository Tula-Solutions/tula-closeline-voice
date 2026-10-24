import type {
  VoiceCall,
  VoiceCallFailureReason,
  VoiceCallState,
  voiceCallCursorSchema,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { IdempotencyScope } from '~/ports/idempotency-store'

/** The position after which the next page of Calls starts. */
export type CallCursor = z.infer<typeof voiceCallCursorSchema>

/** A Call as stored: the contract's Call plus the provider's id for it, never returned. */
export type StoredCall = VoiceCall & { providerCallSid: string | null }

/** What the store needs to create an outbound Call; it starts `ringing`. */
export type NewCall = {
  id: VoiceCall['id']
  lineId: VoiceCall['lineId']
  repMembershipId: string
  prospectId: VoiceCall['prospectId']
  prospectNumber: string
  /** The stored form of the `Idempotency-Key` (a digest, never the raw key), with its fingerprint. */
  idempotency?: { key: string; fingerprint: string }
  createdAt: Date
}

/** A page request. `repMembershipIds` is the visibility filter: `[]` matches nothing. */
export type CallListQuery = {
  cursor?: CallCursor
  limit: number
  state?: VoiceCallState
  direction?: VoiceCall['direction']
  repMembershipId?: string
  lineId?: string
  prospectId?: string
  /** Only Calls created at or after this time. */
  from?: Date
  /** Only Calls created before this time. */
  to?: Date
  /** Only Calls taken by one of these Reps; absent means every Rep's. */
  repMembershipIds?: readonly string[]
}

/** The move of a Call to its next state. */
export type CallTransition = {
  to: VoiceCallState
  at: Date
  /** Required to fail a Call, and only then. */
  failureReason?: VoiceCallFailureReason
  endedBy?: NonNullable<VoiceCall['endedBy']>
}

/** One entry of a Call's ordered event log, as the tests and the timeline read it. */
export type CallLogEntry =
  | { kind: 'state_changed'; fromState: VoiceCallState | null; toState: VoiceCallState; at: Date }
  | { kind: 'disclosure_played' | 'recording_started'; at: Date }

/** Thrown when a Call is moved somewhere {@link CallStore} will not allow. */
export class InvalidTransitionError extends Error {
  constructor(from: VoiceCallState, to: VoiceCallState) {
    super(`a Call cannot move from ${from} to ${to} in this condition`)
    this.name = 'InvalidTransitionError'
  }
}

/** Thrown by {@link CallStore.insert} when the stored idempotency key is taken. */
export class CallKeyTakenError extends Error {
  constructor() {
    super('the idempotency key already placed a Call')
    this.name = 'CallKeyTakenError'
  }
}

/**
 * Where an Organization's Calls are kept. Every method takes the Organization first and can reach
 * that Organization's rows only: another Organization's Call is `undefined`, never an error.
 */
export type CallStore = {
  /**
   * Creates a Call `ringing` and logs the first state change in one step. With `within` the
   * insert joins that idempotency transaction.
   */
  insert: (organizationId: string, call: NewCall, within?: IdempotencyScope) => Promise<StoredCall>
  /** One Call, or `undefined` when this Organization has none with that id. */
  get: (organizationId: string, id: VoiceCall['id']) => Promise<StoredCall | undefined>
  /** The Calls after the cursor, newest first by `(createdAt, id)`, at most `limit`. */
  list: (organizationId: string, query: CallListQuery) => Promise<StoredCall[]>
  /** Remembers the provider's id for the Call once the provider has placed it. */
  setProviderCallSid: (
    organizationId: string,
    id: VoiceCall['id'],
    providerCallSid: string
  ) => Promise<void>
  /**
   * Moves a Call along {@link canTransition}, setting the times, the duration and the failure
   * reason, and logs the change in the same step. Throws {@link InvalidTransitionError} for any
   * other move, including `live` without a stored Disclosure; `undefined` when the Call is missing.
   */
  transition: (
    organizationId: string,
    id: VoiceCall['id'],
    transition: CallTransition
  ) => Promise<StoredCall | undefined>
  /** Stores the Disclosure that played, only while the Call is `disclosing`, and logs it. */
  recordDisclosure: (
    organizationId: string,
    id: VoiceCall['id'],
    disclosure: { wordingVersion: number; aiAssisted: boolean; playedAt: Date }
  ) => Promise<StoredCall | undefined>
  /** Logs that the Recording started; only after the Disclosure has played. */
  recordRecordingStarted: (organizationId: string, id: VoiceCall['id'], at: Date) => Promise<void>
  /** Sets the wrap-up of an ended Call; a field left out is kept and `null` clears it. */
  wrapUp: (
    organizationId: string,
    id: VoiceCall['id'],
    wrapUp: { dealId?: string | null; note?: string | null }
  ) => Promise<StoredCall | undefined>
  /** The Call's event log in the order it happened. */
  events: (organizationId: string, id: VoiceCall['id']) => Promise<CallLogEntry[]>
}
