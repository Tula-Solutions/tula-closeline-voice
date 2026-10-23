import type { OrganizationDirectory } from '~/ports/organization-directory'

/** The in-memory directory plus the calls a test uses to fill it. */
export type MemoryOrganizationDirectory = OrganizationDirectory & {
  /** Declares a Team in an Organization. */
  addTeam: (organizationId: string, teamId: string) => void
  /** Declares a Membership with the Rep role in an Organization. */
  addRep: (organizationId: string, membershipId: string) => void
}

/** A directory held in memory, for tests and local runs. */
export function createMemoryOrganizationDirectory(): MemoryOrganizationDirectory {
  const teams = new Set<string>()
  const reps = new Set<string>()
  const key = (organizationId: string, id: string) => `${organizationId}/${id}`

  return {
    addTeam: (organizationId, teamId) => void teams.add(key(organizationId, teamId)),
    addRep: (organizationId, membershipId) => void reps.add(key(organizationId, membershipId)),
    teamExists: async (organizationId, teamId) => teams.has(key(organizationId, teamId)),
    isRep: async (organizationId, membershipId) => reps.has(key(organizationId, membershipId)),
  }
}
