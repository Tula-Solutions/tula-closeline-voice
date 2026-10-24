import type { Line, LineAssignment } from 'tula-closeline-contract'
import {
  type LineListQuery,
  type LineStore,
  type NewLine,
  NumberTakenError,
  type StoredLine,
} from '~/ports/line-store'

/** An in-memory {@link LineStore} for tests and local runs; it scopes every read by Organization. */
export function createMemoryLineStore(): LineStore {
  const byOrganization = new Map<string, Map<string, StoredLine>>()

  const rowsOf = (organizationId: string): Map<string, StoredLine> => {
    let rows = byOrganization.get(organizationId)
    if (rows === undefined) {
      rows = new Map()
      byOrganization.set(organizationId, rows)
    }
    return rows
  }

  const liveNumbers = (): Set<string> => {
    const numbers = new Set<string>()
    for (const rows of byOrganization.values()) {
      for (const line of rows.values()) {
        if (line.state !== 'released') {
          numbers.add(line.number)
        }
      }
    }
    return numbers
  }

  /** True when `line` sorts strictly after the cursor in newest-first order. */
  const afterCursor = (line: Line, cursor: NonNullable<LineListQuery['cursor']>): boolean =>
    line.createdAt < cursor.createdAt ||
    (line.createdAt === cursor.createdAt && line.id < cursor.id)

  return {
    async insert(organizationId, line: NewLine) {
      if (liveNumbers().has(line.number)) {
        throw new NumberTakenError()
      }
      const stored: StoredLine = {
        id: line.id,
        number: line.number,
        country: line.country,
        label: line.label,
        state: line.state,
        assignment: { kind: 'unassigned' },
        createdAt: line.createdAt.toISOString(),
        releasedAt: null,
        providerSid: line.providerSid,
      }
      rowsOf(organizationId).set(line.id, stored)
      return { ...stored }
    },

    async list(organizationId, query) {
      const lines = [...rowsOf(organizationId).values()]
        .filter((line) => query.state === undefined || line.state === query.state)
        .filter(
          (line) =>
            query.assignedToRep === undefined ||
            (line.assignment.kind === 'rep' && line.assignment.membershipId === query.assignedToRep)
        )
        .filter((line) => query.cursor === undefined || afterCursor(line, query.cursor))
        .sort((a, b) =>
          a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1
        )
      return lines.slice(0, query.limit).map((line) => ({ ...line }))
    },

    async get(organizationId, id) {
      const line = rowsOf(organizationId).get(id)
      return line === undefined ? undefined : { ...line }
    },

    async assign(organizationId, id, assignment: LineAssignment) {
      const line = rowsOf(organizationId).get(id)
      if (line === undefined || line.state === 'released') {
        return undefined
      }
      line.assignment = assignment
      return { ...line }
    },

    async release(organizationId, id, at) {
      const line = rowsOf(organizationId).get(id)
      if (line === undefined) {
        return undefined
      }
      if (line.state !== 'released') {
        line.state = 'released'
        line.assignment = { kind: 'unassigned' }
        line.releasedAt = at.toISOString()
      }
      return { ...line }
    },
    async clearProviderSid(organizationId, id) {
      const line = rowsOf(organizationId).get(id)
      if (line !== undefined && line.state === 'released') {
        line.providerSid = null
      }
    },
  }
}
