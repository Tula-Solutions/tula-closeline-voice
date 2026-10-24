import type { OrganizationDirectory } from '~/ports/organization-directory'

/** The in-memory directory plus the calls a test uses to fill it. */
export type MemoryOrganizationDirectory = OrganizationDirectory & {
  /** Declares a Team in an Organization. */
  addTeam: (organizationId: string, teamId: string) => void
  /** Declares a Membership with the Rep role in an Organization. */
  addRep: (organizationId: string, membershipId: string) => void
  /** Declares that the User holds the Membership in the Organization. */
  addMembership: (organizationId: string, userId: string, membershipId: string) => void
  /** Declares the Reps a Manager's Membership manages. */
  addTeamReps: (organizationId: string, managerMembershipId: string, repIds: string[]) => void
}

/** A directory held in memory, for tests and local runs. */
export function createMemoryOrganizationDirectory(): MemoryOrganizationDirectory {
  const teams = new Set<string>()
  const reps = new Set<string>()
  const memberships = new Map<string, string>()
  const teamReps = new Map<string, string[]>()
  const key = (organizationId: string, id: string) => `${organizationId}/${id}`

  return {
    addMembership: (organizationId, userId, membershipId) =>
      void memberships.set(key(organizationId, userId), membershipId),
    membershipOf: async (organizationId, userId) => memberships.get(key(organizationId, userId)),
    addTeamReps: (organizationId, managerMembershipId, repIds) =>
      void teamReps.set(key(organizationId, managerMembershipId), [...repIds]),
    teamRepsOf: async (organizationId, managerMembershipId) => [
      ...(teamReps.get(key(organizationId, managerMembershipId)) ?? []),
    ],
    addTeam: (organizationId, teamId) => void teams.add(key(organizationId, teamId)),
    addRep: (organizationId, membershipId) => void reps.add(key(organizationId, membershipId)),
    teamExists: async (organizationId, teamId) => teams.has(key(organizationId, teamId)),
    isRep: async (organizationId, membershipId) => reps.has(key(organizationId, membershipId)),
  }
}
