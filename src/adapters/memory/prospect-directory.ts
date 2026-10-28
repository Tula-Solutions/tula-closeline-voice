import type { ProspectContact, ProspectDirectory } from '~/ports/prospect-directory'

/** The in-memory directory plus the call a test uses to fill it. */
export type MemoryProspectDirectory = ProspectDirectory & {
  /** Declares a Prospect; only Owner, Admin and the listed Users see them as a viewer. */
  add: (
    organizationId: string,
    prospectId: string,
    contact: Partial<ProspectContact> & { visibleTo?: string[] }
  ) => void
}

/** A Prospect directory held in memory, for tests and local runs. */
export function createMemoryProspectDirectory(): MemoryProspectDirectory {
  const rows = new Map<string, ProspectContact & { visibleTo: string[] }>()
  const key = (organizationId: string, id: string) => `${organizationId}/${id}`
  return {
    add: (organizationId, prospectId, { phone = null, timeZone = null, visibleTo = [] }) =>
      void rows.set(key(organizationId, prospectId), { phone, timeZone, visibleTo }),
    lookup: async (organizationId, prospectId, viewer) => {
      const row = rows.get(key(organizationId, prospectId))
      if (row === undefined) {
        return undefined
      }
      const sees =
        viewer === undefined ||
        viewer.role === 'owner' ||
        viewer.role === 'admin' ||
        row.visibleTo.includes(viewer.userId)
      return sees ? { phone: row.phone, timeZone: row.timeZone } : undefined
    },
  }
}
