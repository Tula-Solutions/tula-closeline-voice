import {
  AgentCallOpenError,
  type AgentCallStore,
  type NewAgentCall,
  type StoredAgentCall,
} from '~/ports/agent-call-store'

/** The in-memory store plus the calls a test uses to set caps and record dials. */
export type MemoryAgentCallStore = AgentCallStore & {
  /** Sets a Line's caps; a Line never set has the defaults (3 concurrent, 150 a day). */
  setLineCaps: (lineId: string, caps: { concurrent?: number; daily?: number }) => void
  /** Marks a stored Agent Call as dialed at `at` to the number (what T8's dial will do). */
  recordDial: (
    organizationId: string,
    id: string,
    dial: { numberHash: Uint8Array; at: Date; lineId: string; open?: boolean; answered?: boolean }
  ) => void
}

type Row = {
  call: StoredAgentCall
  key: string
  numberHash?: string
  dialedAt?: Date
  retry?: Date
}

const OPEN = new Set(['queued', 'dialing', 'live'])
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/** An Agent Call store held in memory, enforcing the same uniqueness rules as the Postgres one. */
export function createMemoryAgentCallStore(): MemoryAgentCallStore {
  const organizations = new Map<string, Map<string, Row>>()
  const caps = new Map<string, { concurrent: number; daily: number }>()
  const rowsOf = (organizationId: string): Map<string, Row> => {
    let rows = organizations.get(organizationId)
    if (rows === undefined) {
      rows = new Map()
      organizations.set(organizationId, rows)
    }
    return rows
  }
  const all = (organizationId: string) => [...rowsOf(organizationId).values()]
  const toCall = (call: NewAgentCall): StoredAgentCall => ({
    id: call.id,
    source: call.source,
    prospectId: call.prospectId,
    lineId: call.lineId,
    enrollmentId: call.enrollmentId,
    stepKey: call.stepKey,
    requestedByMembershipId: call.requestedByMembershipId,
    attempt: call.attempt,
    state: call.state,
    result: call.result,
    endReason: null,
    gateCode: call.gateCode,
    retryAt: call.retryAt?.toISOString() ?? null,
    callId: null,
    durationSeconds: null,
    createdAt: call.createdAt.toISOString(),
    endedAt: call.state === 'ended' ? call.createdAt.toISOString() : null,
  })

  return {
    setLineCaps: (lineId, next) =>
      void caps.set(lineId, { concurrent: next.concurrent ?? 3, daily: next.daily ?? 150 }),
    recordDial(organizationId, id, dial) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined) {
        return
      }
      row.numberHash = hex(dial.numberHash)
      row.dialedAt = dial.at
      row.call = {
        ...row.call,
        lineId: dial.lineId,
        retryAt: null,
        ...(dial.open === false
          ? {
              state: 'ended',
              result: dial.answered ? 'answered' : 'no_answer',
              endReason: dial.answered ? 'completed' : null,
              callId: null,
              endedAt: dial.at.toISOString(),
            }
          : { state: 'dialing' }),
      } as StoredAgentCall
    },

    async insert(organizationId, call) {
      const rows = rowsOf(organizationId)
      const same = all(organizationId).find((row) => row.key === call.idempotencyKey)
      if (same !== undefined) {
        return { call: { ...same.call }, created: false }
      }
      const open = all(organizationId).find(
        (row) => row.call.prospectId === call.prospectId && OPEN.has(row.call.state)
      )
      if (open !== undefined && OPEN.has(call.state)) {
        throw new AgentCallOpenError(open.call.id)
      }
      const stored = toCall(call)
      rows.set(call.id, { call: stored, key: call.idempotencyKey })
      return { call: { ...stored }, created: true }
    },
    byKey: async (organizationId, key) => {
      const row = all(organizationId).find((r) => r.key === key)
      return row === undefined ? undefined : { ...row.call }
    },
    get: async (organizationId, id) => {
      const row = rowsOf(organizationId).get(id)
      return row === undefined ? undefined : { ...row.call }
    },
    openFor: async (organizationId, prospectId) => {
      const row = all(organizationId).find(
        (r) => r.call.prospectId === prospectId && OPEN.has(r.call.state)
      )
      return row === undefined ? undefined : { ...row.call }
    },
    numberDials: async (organizationId, numberHash, since) => {
      const times = all(organizationId)
        .filter((r) => r.numberHash === hex(numberHash) && r.dialedAt && r.dialedAt >= since)
        .map((r) => r.dialedAt as Date)
        .sort((a, b) => a.getTime() - b.getTime())
      return { count: times.length, oldestAt: times[0] ?? null }
    },
    stepAttempts: async (organizationId, enrollmentId, stepKey) => {
      const rows = all(organizationId).filter(
        (r) => r.call.enrollmentId === enrollmentId && r.call.stepKey === stepKey && r.dialedAt
      )
      return { dialed: rows.length, answered: rows.some((r) => r.call.result === 'answered') }
    },
    lineUsage: async (organizationId, lineId, since) => {
      const own = caps.get(lineId) ?? { concurrent: 3, daily: 150 }
      const rows = all(organizationId).filter((r) => r.call.lineId === lineId)
      const times = rows
        .filter((r) => r.dialedAt && r.dialedAt >= since)
        .map((r) => r.dialedAt as Date)
        .sort((a, b) => a.getTime() - b.getTime())
      return {
        maxConcurrentAgentCalls: own.concurrent,
        dailyAgentDialCap: own.daily,
        open: rows.filter((r) => r.call.state === 'dialing' || r.call.state === 'live').length,
        dials: times.length,
        oldestDialAt: times[0] ?? null,
      }
    },
    settle: async (organizationId, id, settlement) => {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined || row.call.state !== 'queued') {
        return undefined
      }
      row.call =
        settlement.kind === 'blocked'
          ? {
              ...row.call,
              state: 'ended',
              result: 'blocked',
              gateCode: settlement.gateCode,
              retryAt: null,
              endedAt: settlement.at.toISOString(),
            }
          : {
              ...row.call,
              gateCode: settlement.gateCode,
              retryAt: settlement.retryAt.toISOString(),
            }
      return { ...row.call }
    },
  }
}
