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
}
