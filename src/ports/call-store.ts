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
export type StoredCall = VoiceCall & {
  providerCallSid: string | null
  /** What the Agent's speech, hearing and thinking have cost so far, in micro-cents; never returned. */
  agentCostMicroCents: number
  /** Whether the Call was placed with the Copilot on; set at place time, never changed. */
  copilot: boolean
  /** Why the live Transcript stopped, or null while it has not; shared by every instance. */
  transcriptUnavailable: TranscriptUnavailableReason | null
}

/** Why a Call's live Transcript stopped, as the stream names it. */
export type TranscriptUnavailableReason = 'speech_to_text_failed' | 'stream_dropped'

/** What the store needs to create an outbound Call; it starts `ringing`. */
export type NewCall = {
  id: VoiceCall['id']
  lineId: VoiceCall['lineId']
  repMembershipId: string
  prospectId: VoiceCall['prospectId']
  prospectNumber: string
  /** Whether the Rep asked for the Copilot; it picks the Disclosure wording when the Prospect answers. */
  copilot?: boolean
  /** The stored form of the `Idempotency-Key` (a digest, never the raw key), with its fingerprint. */
  idempotency?: { key: string; fingerprint: string }
  createdAt: Date
}

/** What the store needs to create an inbound Call; it starts `ringing`. */
export type NewInboundCall = {
  id: VoiceCall['id']
  lineId: VoiceCall['lineId']
  /** The Rep whose Line it is, or `null` when a Team's Reps ring and none has answered yet. */
  repMembershipId: string | null
  callerNumber: string
  /** The provider's id for the call; a second insert with it finds the first Call. */
  providerCallSid: string
  createdAt: Date
}

/** What the store needs to create an outbound Call the Agent places; it starts `ringing`. */
export type NewAgentOutboundCall = {
  id: VoiceCall['id']
  lineId: VoiceCall['lineId']
  prospectId: NonNullable<VoiceCall['prospectId']>
  prospectNumber: string
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
  /** Why an `ended` Call ended; allowed only with `ended`. */
  endReason?: NonNullable<VoiceCall['endReason']>
  /**
   * Set when the Agent answered the Call: it may then go `live` only after a Disclosure that said
   * an AI is speaking, so a recording-only wording can never open an Agent's Call.
   */
  agent?: true
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
  /**
   * Creates an inbound Call `ringing`, once per provider call id: a repeat returns the Call the
   * first insert made with `created: false`.
   */
  insertInbound: (
    organizationId: string,
    call: NewInboundCall
  ) => Promise<{ call: StoredCall; created: boolean }>
  /**
   * Creates the outbound Call of an Agent Call `ringing`, held by no Rep, once per id: a repeat
   * returns the Call the first insert made with `created: false`.
   */
  insertAgentOutbound: (
    organizationId: string,
    call: NewAgentOutboundCall
  ) => Promise<{ call: StoredCall; created: boolean }>
  /**
   * Gives a `ringing` inbound Call to the Rep, moving it to `connecting`, in one conditional
   * update, so of any number of simultaneous answers exactly one returns the Call. `undefined`
   * when the Call is not ringing, is not inbound, or belongs to another Rep.
   */
  claimInbound: (
    organizationId: string,
    id: VoiceCall['id'],
    repMembershipId: string,
    at: Date
  ) => Promise<StoredCall | undefined>
  /**
   * Gives a `ringing` inbound Call that no Rep holds to the Agent, moving it to `connecting`, in
   * one conditional update, so the Agent and a Rep never both answer it. `undefined` when the Call
   * is not ringing, is not inbound, or already belongs to a Rep.
   */
  claimForAgent: (
    organizationId: string,
    id: VoiceCall['id'],
    at: Date
  ) => Promise<StoredCall | undefined>
  /**
   * Up to `limit` Organization ids, ascending and strictly after `after` (null starts at the
   * beginning), that hold an inbound Call still `ringing` since before `before`.
   */
  organizationsWithStaleRinging: (
    before: Date,
    after: string | null,
    limit: number
  ) => Promise<string[]>
  /**
   * Moves up to `limit` of the Organization's inbound Calls that have been `ringing` since before
   * `before` to `missed`, in one conditional update, and returns them. A Call a Rep claimed in the
   * meantime is not `ringing` and is not touched, so repeating this is harmless.
   */
  missStaleRinging: (
    organizationId: string,
    before: Date,
    at: Date,
    limit: number
  ) => Promise<StoredCall[]>
  /**
   * Up to `limit` Organization ids, ascending and strictly after `after`, that hold an outbound
   * Call still `ringing` or `connecting` since before `before`.
   */
  organizationsWithStaleOutbound: (
    before: Date,
    after: string | null,
    limit: number
  ) => Promise<string[]>
  /**
   * Moves up to `limit` of the Organization's outbound Calls that have been `ringing` (reason
   * `no_answer`) or `connecting` (reason `provider_error`) since before `before` to `failed`, in
   * one conditional update, and returns them. A Call that moved on meanwhile is not touched.
   */
  failStaleOutbound: (
    organizationId: string,
    before: Date,
    at: Date,
    limit: number
  ) => Promise<StoredCall[]>
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
  /** Records that the live Transcript of a Call stopped; the Call itself is untouched. */
  markTranscriptUnavailable: (
    organizationId: string,
    id: VoiceCall['id'],
    reason: TranscriptUnavailableReason
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
  /**
   * Seats a Rep on a `live` Agent Call that has none (a warm Handoff) and stores the Disclosure
   * that played to them, logging it. `undefined` when the Call is missing, not live or has a Rep.
   */
  joinRep: (
    organizationId: string,
    id: VoiceCall['id'],
    join: {
      repMembershipId: string
      disclosure: { wordingVersion: number; aiAssisted: boolean; playedAt: Date }
    }
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
