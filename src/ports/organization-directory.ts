import type { Role } from 'tula-closeline-contract'

/** What the Lines routes need to know about an Organization's people, held by the core service. */
export type OrganizationDirectory = {
  /** Whether the Team exists in the Organization. */
  teamExists: (organizationId: string, teamId: string) => Promise<boolean>
  /** Whether the Membership exists in the Organization and holds the Rep role. */
  isRep: (organizationId: string, membershipId: string) => Promise<boolean>
  /** Whether the Membership exists in the Organization, whatever its role. */
  isMember: (organizationId: string, membershipId: string) => Promise<boolean>
  /** The Membership ids holding the role in the Organization (at most 50). */
  roleMembers: (organizationId: string, role: Role) => Promise<string[]>
  /** The ids of the Teams the Membership belongs to (at most 50). */
  teamsOf: (organizationId: string, membershipId: string) => Promise<string[]>
  /** The Membership id the User holds in the Organization, or undefined when they hold none. */
  membershipOf: (organizationId: string, userId: string) => Promise<string | undefined>
  /** The Membership ids of the Team's Reps who are online to take a Call (at most 50). */
  onlineRepsOfTeam: (organizationId: string, teamId: string) => Promise<string[]>
  /** The Membership ids of the Reps on every Team the Manager manages (at most 500). */
  teamRepsOf: (organizationId: string, managerMembershipId: string) => Promise<string[]>
  /** The Organization's display name for the Agent's opening words, or undefined when not known. */
  nameOf: (organizationId: string) => Promise<string | undefined>
}
