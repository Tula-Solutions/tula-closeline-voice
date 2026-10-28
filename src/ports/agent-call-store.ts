import type { AgentCall } from 'tula-closeline-contract'

/** An Agent Call as the contract shows it. */
export type StoredAgentCall = AgentCall

/** What the store needs to record a request: queued for dialing, deferred, or blocked and ended. */
export type NewAgentCall = {
  id: AgentCall['id']
  idempotencyKey: string
  source: AgentCall['source']
  prospectId: AgentCall['prospectId']
  lineId: AgentCall['lineId']
  enrollmentId: AgentCall['enrollmentId']
  stepKey: AgentCall['stepKey']
  requestedByMembershipId: AgentCall['requestedByMembershipId']
  attempt: number
  state: 'queued' | 'ended'
  /** `blocked` for a refusal, `null` for a queued row. */
  result: 'blocked' | null
  gateCode: AgentCall['gateCode']
  /** Set exactly on a queued row: when the dial may be tried. */
  retryAt: Date | null
  createdAt: Date
}

/** How a gate decision settles a queued row: refused for good, or deferred to a later time. */
export type Settlement =
  | { kind: 'blocked'; gateCode: NonNullable<AgentCall['gateCode']>; at: Date }
  | { kind: 'deferred'; gateCode: NonNullable<AgentCall['gateCode']>; retryAt: Date }

/** What a Line has used and may use, for the Line caps. */
export type LineUsage = {
  maxConcurrentAgentCalls: number
  dailyAgentDialCap: number
  /** Agent Calls dialing or live on the Line now. */
  open: number
  /** Dials on the Line since the window start, and the time of the oldest of them. */
  dials: number
  oldestDialAt: Date | null
}

/** Whether a Line has no room for another dial: all slots open, or the daily cap spent. */
export function lineIsFull(usage: LineUsage): boolean {
  return (
    usage.open >= usage.maxConcurrentAgentCalls ||
    (usage.dials >= usage.dailyAgentDialCap && usage.oldestDialAt !== null)
  )
}

/** What a dial claim needs: when, to which number, under which Call id, and the last Contact Check. */
export type DialClaim = {
  at: Date
  numberHash: Uint8Array
  /** The id of the voice Call the dial will create; stored on the row as it moves to `dialing`. */
  callId: string
  /** Start of the daily window the Line cap counts from. */
  since: Date
  /** Runs inside the claim, with the Line held; returns a settlement to refuse the dial. */
  contactCheck: () => Promise<Settlement | undefined>
}

/** The outcome of {@link AgentCallStore.claimDial}. */
export type ClaimOutcome =
  | { kind: 'claimed'; call: StoredAgentCall }
  | { kind: 'capped'; usage: LineUsage }
  | { kind: 'refused'; settlement: Settlement }
  | { kind: 'gone' }

/** How a dialed Agent Call ended. */
export type Finish = {
  result: NonNullable<AgentCall['result']>
  endReason: AgentCall['endReason']
  durationSeconds: number | null
  at: Date
}

/** Thrown by {@link AgentCallStore.insert} when the Prospect already has a queued, dialing or live Agent Call. */
export class AgentCallOpenError extends Error {
  constructor(readonly agentCallId: string) {
    super('an Agent Call to this Prospect is already under way')
    this.name = 'AgentCallOpenError'
  }
}

/**
 * Where Agent Calls are kept. Every method takes the Organization first and reaches that
 * Organization's rows only. The gate's counts come from here, never from memory.
 */
export type AgentCallStore = {
  /**
   * Records a request. A key already used answers the existing row with `created: false`; a Prospect
   * with an open Agent Call rejects with {@link AgentCallOpenError}.
   */
  insert: (
    organizationId: string,
    call: NewAgentCall
  ) => Promise<{ call: StoredAgentCall; created: boolean }>
  /** One Agent Call by its request key. */
  byKey: (organizationId: string, key: string) => Promise<StoredAgentCall | undefined>
  /** One Agent Call by id. */
  get: (organizationId: string, id: string) => Promise<StoredAgentCall | undefined>
  /** The queued, dialing or live Agent Call to the Prospect, if any. */
  openFor: (organizationId: string, prospectId: string) => Promise<StoredAgentCall | undefined>
  /** Dials to one number (by keyed hash) since `since`, and the time of the oldest. */
  numberDials: (
    organizationId: string,
    numberHash: Uint8Array,
    since: Date
  ) => Promise<{ count: number; oldestAt: Date | null }>
  /** How often a call Step was dialed, and whether one of them was answered. */
  stepAttempts: (
    organizationId: string,
    enrollmentId: string,
    stepKey: string
  ) => Promise<{ dialed: number; answered: boolean }>
  /** A Line's caps and use since `since`; `undefined` when the Organization has no such Line. */
  lineUsage: (organizationId: string, lineId: string, since: Date) => Promise<LineUsage | undefined>
  /** Settles a queued row after a gate re-run; `undefined` when it is not queued any more. */
  settle: (
    organizationId: string,
    id: string,
    settlement: Settlement
  ) => Promise<StoredAgentCall | undefined>
  /**
   * Moves a queued row to `dialing` and stamps `dialedAt`, but only when, with the Line held for the
   * duration, the Line caps still have room and the Contact Check still allows the dial. Two
   * concurrent claims on one Line therefore cannot exceed a cap.
   */
  claimDial: (organizationId: string, id: string, claim: DialClaim) => Promise<ClaimOutcome>
  /** Moves a dialing row to `live`; `undefined` when it is not dialing. */
  markLive: (organizationId: string, id: string) => Promise<StoredAgentCall | undefined>
  /** Ends a dialing or live row once; `undefined` when it already ended, so a replay changes nothing. */
  finish: (
    organizationId: string,
    id: string,
    finish: Finish
  ) => Promise<StoredAgentCall | undefined>
  /** The Agent Call that owns a voice Call. */
  byCallId: (organizationId: string, callId: string) => Promise<StoredAgentCall | undefined>
}
