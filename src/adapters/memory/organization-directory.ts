import type { Role } from 'tula-closeline-contract'
import type { OrganizationDirectory } from '~/ports/organization-directory'

/** The in-memory directory plus the calls a test uses to fill it. */
export type MemoryOrganizationDirectory = OrganizationDirectory & {
  /** Declares a Team in an Organization. */
  addTeam: (organizationId: string, teamId: string) => void
  /** Declares a Membership holding any role in an Organization. */
  addMember: (organizationId: string, membershipId: string, role: Role) => void
  /** Declares that the Membership belongs to the Team. */
  addTeamMember: (organizationId: string, teamId: string, membershipId: string) => void
  /** Declares a Membership with the Rep role in an Organization. */
  addRep: (organizationId: string, membershipId: string) => void
  /** Declares that the User holds the Membership in the Organization. */
  addMembership: (organizationId: string, userId: string, membershipId: string) => void
  /** Declares the Reps a Manager's Membership manages. */
  addTeamReps: (organizationId: string, managerMembershipId: string, repIds: string[]) => void
  /** Declares which Reps of a Team are online to take Calls. */
  setOnlineReps: (organizationId: string, teamId: string, repIds: string[]) => void
}

/** A directory held in memory, for tests and local runs. */
export function createMemoryOrganizationDirectory(): MemoryOrganizationDirectory {
  const teams = new Set<string>()
  const members = new Map<string, Role>()
  const teamMembers = new Map<string, string[]>()
  const memberships = new Map<string, string>()
  const teamReps = new Map<string, string[]>()
  const online = new Map<string, string[]>()
  const key = (organizationId: string, id: string) => `${organizationId}/${id}`

  return {
    setOnlineReps: (organizationId, teamId, repIds) =>
      void online.set(key(organizationId, teamId), [...repIds]),
    onlineRepsOfTeam: async (organizationId, teamId) => [
      ...(online.get(key(organizationId, teamId)) ?? []),
    ],
    addMembership: (organizationId, userId, membershipId) =>
      void memberships.set(key(organizationId, userId), membershipId),
    membershipOf: async (organizationId, userId) => memberships.get(key(organizationId, userId)),
    addTeamReps: (organizationId, managerMembershipId, repIds) =>
      void teamReps.set(key(organizationId, managerMembershipId), [...repIds]),
    teamRepsOf: async (organizationId, managerMembershipId) => [
      ...(teamReps.get(key(organizationId, managerMembershipId)) ?? []),
    ],
    addTeam: (organizationId, teamId) => void teams.add(key(organizationId, teamId)),
    addMember: (organizationId, membershipId, role) =>
      void members.set(key(organizationId, membershipId), role),
    addRep: (organizationId, membershipId) =>
      void members.set(key(organizationId, membershipId), 'rep'),
    addTeamMember: (organizationId, teamId, membershipId) =>
      void teamMembers.set(key(organizationId, teamId), [
        ...(teamMembers.get(key(organizationId, teamId)) ?? []),
        membershipId,
      ]),
    isMember: async (organizationId, membershipId) =>
      members.has(key(organizationId, membershipId)),
    roleMembers: async (organizationId, role) =>
      [...members]
        .filter(([k, r]) => r === role && k.startsWith(`${organizationId}/`))
        .map(([k]) => k.slice(organizationId.length + 1)),
    teamsOf: async (organizationId, membershipId) =>
      [...teamMembers]
        .filter(([k, ids]) => k.startsWith(`${organizationId}/`) && ids.includes(membershipId))
        .map(([k]) => k.slice(organizationId.length + 1)),
    teamExists: async (organizationId, teamId) => teams.has(key(organizationId, teamId)),
    isRep: async (organizationId, membershipId) =>
      members.get(key(organizationId, membershipId)) === 'rep',
  }
}
