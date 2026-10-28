import { formatId, type Handoff } from 'tula-closeline-contract'
import type { HandoffStore } from '~/ports/handoff-store'

/** An in-memory {@link HandoffStore} for tests and local runs. */
export function createMemoryHandoffStore(): HandoffStore {
  const byOrganization = new Map<string, Map<string, Handoff>>()
  const rowsOf = (organizationId: string) => {
    let rows = byOrganization.get(organizationId)
    if (rows === undefined) {
      rows = new Map()
      byOrganization.set(organizationId, rows)
    }
    return rows
  }
  const live = (state: Handoff['state']) => state === 'pending' || state === 'accepted'
  const base = (callId: string): Pick<Handoff, 'channel' | 'callId' | 'chatId'> => ({
    channel: 'call',
    callId: callId as Handoff['callId'],
    chatId: null,
  })

  return {
    async offer(organizationId, offer) {
      const rows = rowsOf(organizationId)
      for (const row of rows.values()) {
        if (row.callId === offer.callId && live(row.state)) {
          return undefined
        }
      }
      const handoff: Handoff = {
        id: formatId('hof', crypto.randomUUID()),
        state: 'pending',
        ...base(offer.callId),
        repMembershipId: offer.repMembershipId as Handoff['repMembershipId'],
        attempt: offer.attempt,
        reason: offer.reason,
        requestedAt: offer.at.toISOString(),
        answeredAt: null,
        completedAt: null,
      }
      rows.set(handoff.id, handoff)
      return structuredClone(handoff)
    },
    async get(organizationId, id) {
      const row = rowsOf(organizationId).get(id)
      return row === undefined ? undefined : structuredClone(row)
    },
    async forCall(organizationId, callId) {
      return [...rowsOf(organizationId).values()]
        .filter((row) => row.callId === callId)
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.attempt - b.attempt)
        .map((row) => structuredClone(row))
    },
    async answer(organizationId, id, repMembershipId, answer, at) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined || row.state !== 'pending' || row.repMembershipId !== repMembershipId) {
        return undefined
      }
      row.state = answer
      row.answeredAt = at.toISOString()
      return structuredClone(row)
    },
    async expire(organizationId, id) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined || row.state !== 'pending') {
        return undefined
      }
      row.state = 'timed_out'
      return structuredClone(row)
    },
    async complete(organizationId, id, _result, at) {
      const row = rowsOf(organizationId).get(id)
      if (row === undefined || row.state !== 'accepted') {
        return undefined
      }
      row.state = 'completed'
      row.completedAt = at.toISOString()
      return structuredClone(row)
    },
    async noRep(organizationId, entry) {
      const handoff: Handoff = {
        id: formatId('hof', crypto.randomUUID()),
        state: 'no_rep',
        ...base(entry.callId),
        repMembershipId: null,
        attempt: entry.attempt,
        reason: entry.reason,
        requestedAt: entry.at.toISOString(),
        answeredAt: null,
        completedAt: entry.at.toISOString(),
      }
      rowsOf(organizationId).set(handoff.id, handoff)
      return structuredClone(handoff)
    },
  }
}
