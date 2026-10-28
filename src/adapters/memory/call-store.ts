import type { VoiceCall } from 'tula-closeline-contract'
import { canTransition } from '~/modules/call/state'
import {
  CallKeyTakenError,
  type CallLogEntry,
  type CallStore,
  InvalidTransitionError,
  type StoredCall,
} from '~/ports/call-store'

/** The in-memory Call store plus what a test uses to read the event log back. */
export type MemoryCallStore = CallStore & {
  /** The ids of every Call of the Organization, in creation order. */
  idsOf: (organizationId: string) => string[]
  /**
   * Adds to the Agent's cost on a Call and returns the new total, `undefined` for no such Call.
   * For the memory turn store only: the port deliberately has no way to add cost apart from a turn.
   */
  addAgentCost: (organizationId: string, id: string, microCents: number) => number | undefined
}

type Row = { call: StoredCall; log: CallLogEntry[]; key: string | undefined }

/** A Call store held in memory, enforcing the same state rules as the Postgres one. */
export function createMemoryCallStore(): MemoryCallStore {
  const organizations = new Map<string, Map<string, Row>>()
  const rowsOf = (organizationId: string): Map<string, Row> => {
    let rows = organizations.get(organizationId)
    if (rows === undefined) {
      rows = new Map()
      organizations.set(organizationId, rows)
    }
    return rows
  }
  const copy = (call: StoredCall): StoredCall => ({
    ...call,
    disclosure: { ...call.disclosure },
  })

  const isStale = (call: StoredCall, before: Date): boolean =>
    call.direction === 'inbound' &&
    call.state === 'ringing' &&
    Date.parse(call.createdAt) < before.getTime()

  return {
    idsOf: (organizationId) => [...rowsOf(organizationId).keys()],

    addAgentCost(organizationId, id, microCents) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined) {
        return undefined
      }
      row.call.agentCostMicroCents += microCents
      return row.call.agentCostMicroCents
    },

    async insert(organizationId, input) {
      const rows = rowsOf(organizationId)
      if (
        input.idempotency !== undefined &&
        [...rows.values()].some((row) => row.key === input.idempotency?.key)
      ) {
        throw new CallKeyTakenError()
      }
      const at = input.createdAt
      const call: StoredCall = {
        id: input.id,
        direction: 'outbound',
        state: 'ringing',
        lineId: input.lineId,
        repMembershipId: input.repMembershipId as VoiceCall['repMembershipId'],
        prospectId: input.prospectId,
        prospectNumber: input.prospectNumber,
        disclosure: { wordingVersion: null, playedAt: null, aiAssisted: false },
        createdAt: at.toISOString(),
        answeredAt: null,
        endedAt: null,
        durationSeconds: null,
        endedBy: null,
        failureReason: null,
        dealId: null,
        note: null,
        recordingState: 'none',
        transcriptState: 'pending',
        providerCallSid: null,
        endReason: null,
        agentCostMicroCents: 0,
      }
      rows.set(call.id, {
        call,
        key: input.idempotency?.key,
        log: [{ kind: 'state_changed', fromState: null, toState: 'ringing', at }],
      })
      return copy(call)
    },

    async insertInbound(organizationId, input) {
      const rows = rowsOf(organizationId)
      const existing = [...rows.values()].find(
        (row) => row.call.providerCallSid === input.providerCallSid
      )
      if (existing !== undefined) {
        return { call: copy(existing.call), created: false }
      }
      const call: StoredCall = {
        id: input.id,
        direction: 'inbound',
        state: 'ringing',
        lineId: input.lineId,
        repMembershipId: input.repMembershipId as VoiceCall['repMembershipId'],
        prospectId: null,
        prospectNumber: input.callerNumber,
        disclosure: { wordingVersion: null, playedAt: null, aiAssisted: false },
        createdAt: input.createdAt.toISOString(),
        answeredAt: null,
        endedAt: null,
        durationSeconds: null,
        endedBy: null,
        failureReason: null,
        dealId: null,
        note: null,
        recordingState: 'none',
        transcriptState: 'pending',
        providerCallSid: input.providerCallSid,
        endReason: null,
        agentCostMicroCents: 0,
      }
      rows.set(call.id, {
        call,
        key: undefined,
        log: [{ kind: 'state_changed', fromState: null, toState: 'ringing', at: input.createdAt }],
      })
      return { call: copy(call), created: true }
    },

    async claimInbound(organizationId, id, repMembershipId, at) {
      // No await between the check and the write: this is the memory form of one conditional update.
      const row = rowsOf(organizationId).get(id)
      if (
        row === undefined ||
        row.call.direction !== 'inbound' ||
        row.call.state !== 'ringing' ||
        (row.call.repMembershipId !== null && row.call.repMembershipId !== repMembershipId)
      ) {
        return undefined
      }
      row.call.state = 'connecting'
      row.call.repMembershipId = repMembershipId as VoiceCall['repMembershipId']
      row.log.push({ kind: 'state_changed', fromState: 'ringing', toState: 'connecting', at })
      return copy(row.call)
    },

    async claimForAgent(organizationId, id, at) {
      const row = rowsOf(organizationId).get(id)
      if (
        row === undefined ||
        row.call.direction !== 'inbound' ||
        row.call.state !== 'ringing' ||
        row.call.repMembershipId !== null
      ) {
        return undefined
      }
      row.call.state = 'connecting'
      row.log.push({ kind: 'state_changed', fromState: 'ringing', toState: 'connecting', at })
      return copy(row.call)
    },

    async organizationsWithStaleRinging(before, after, limit) {
      return [...organizations.entries()]
        .filter(
          ([id, rows]) =>
            (after === null || id > after) &&
            [...rows.values()].some((row) => isStale(row.call, before))
        )
        .map(([id]) => id)
        .sort()
        .slice(0, limit)
    },

    async missStaleRinging(organizationId, before, at, limit) {
      const missed: StoredCall[] = []
      for (const row of rowsOf(organizationId).values()) {
        if (missed.length >= limit) {
          break
        }
        if (isStale(row.call, before)) {
          row.call.state = 'missed'
          row.call.endedAt = at.toISOString()
          row.log.push({ kind: 'state_changed', fromState: 'ringing', toState: 'missed', at })
          missed.push(copy(row.call))
        }
      }
      return missed
    },

    async get(organizationId, id) {
      const row = rowsOf(organizationId).get(id)
      return row === undefined ? undefined : copy(row.call)
    },

    async list(organizationId, query) {
      const visible = query.repMembershipIds
      return [...rowsOf(organizationId).values()]
        .map((row) => row.call)
        .filter(
          (call) =>
            (visible === undefined ||
              (call.repMembershipId !== null && visible.includes(call.repMembershipId))) &&
            (query.state === undefined || call.state === query.state) &&
            (query.direction === undefined || call.direction === query.direction) &&
            (query.repMembershipId === undefined ||
              call.repMembershipId === query.repMembershipId) &&
            (query.lineId === undefined || call.lineId === query.lineId) &&
            (query.prospectId === undefined || call.prospectId === query.prospectId) &&
            (query.from === undefined || Date.parse(call.createdAt) >= query.from.getTime()) &&
            (query.to === undefined || Date.parse(call.createdAt) < query.to.getTime())
        )
        .sort((a, b) =>
          a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1
        )
        .filter(
          (call) =>
            query.cursor === undefined ||
            call.createdAt < query.cursor.createdAt ||
            (call.createdAt === query.cursor.createdAt && call.id < query.cursor.id)
        )
        .slice(0, query.limit)
        .map(copy)
    },

    async setProviderCallSid(organizationId, id, providerCallSid) {
      const row = rowsOf(organizationId).get(id)
      if (row !== undefined) {
        row.call.providerCallSid = providerCallSid
      }
    },

    async transition(organizationId, id, move) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined) {
        return undefined
      }
      const { call } = row
      if (
        !canTransition(call.state, move.to, call.disclosure.wordingVersion) ||
        (move.to === 'failed') !== (move.failureReason !== undefined) ||
        (move.failureReason === 'disclosure_failed' && call.disclosure.playedAt !== null) ||
        (move.endReason !== undefined && move.to !== 'ended') ||
        (move.to === 'live' && move.agent === true && !call.disclosure.aiAssisted)
      ) {
        throw new InvalidTransitionError(call.state, move.to)
      }
      const from = call.state
      const at = move.at.toISOString()
      call.state = move.to
      if (move.to === 'live') {
        call.answeredAt = at
      }
      if (move.to === 'ended' || move.to === 'failed' || move.to === 'missed') {
        call.endedAt = at
        call.endedBy = move.endedBy ?? null
      }
      if (move.to === 'ended' && call.answeredAt !== null) {
        call.durationSeconds = Math.max(
          0,
          Math.floor((move.at.getTime() - Date.parse(call.answeredAt)) / 1000)
        )
      }
      if (move.endReason !== undefined) {
        call.endReason = move.endReason
      }
      if (move.failureReason !== undefined) {
        call.failureReason = move.failureReason
      }
      row.log.push({ kind: 'state_changed', fromState: from, toState: move.to, at: move.at })
      return copy(call)
    },

    async recordDisclosure(organizationId, id, disclosure) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined) {
        return undefined
      }
      if (row.call.state !== 'disclosing' || row.call.disclosure.playedAt !== null) {
        throw new InvalidTransitionError(row.call.state, 'disclosing')
      }
      row.call.disclosure = {
        wordingVersion: disclosure.wordingVersion,
        playedAt: disclosure.playedAt.toISOString(),
        aiAssisted: disclosure.aiAssisted,
      }
      row.log.push({ kind: 'disclosure_played', at: disclosure.playedAt })
      return copy(row.call)
    },

    async joinRep(organizationId, id, join) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined || row.call.state !== 'live' || row.call.repMembershipId !== null) {
        return undefined
      }
      row.call.repMembershipId = join.repMembershipId as VoiceCall['repMembershipId']
      row.call.disclosure = {
        wordingVersion: join.disclosure.wordingVersion,
        playedAt: join.disclosure.playedAt.toISOString(),
        aiAssisted: join.disclosure.aiAssisted,
      }
      row.log.push({ kind: 'disclosure_played', at: join.disclosure.playedAt })
      return copy(row.call)
    },

    async recordRecordingStarted(organizationId, id, at) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined) {
        return
      }
      if (row.call.disclosure.playedAt === null) {
        throw new InvalidTransitionError(row.call.state, row.call.state)
      }
      row.log.push({ kind: 'recording_started', at })
    },

    async wrapUp(organizationId, id, wrapUp) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined) {
        return undefined
      }
      if (row.call.state !== 'ended') {
        throw new InvalidTransitionError(row.call.state, 'ended')
      }
      if (wrapUp.dealId !== undefined) {
        row.call.dealId = wrapUp.dealId as VoiceCall['dealId']
      }
      if (wrapUp.note !== undefined) {
        row.call.note = wrapUp.note as VoiceCall['note']
      }
      return copy(row.call)
    },

    async events(organizationId, id) {
      return [...(rowsOf(organizationId).get(id)?.log ?? [])]
    },
  }
}
