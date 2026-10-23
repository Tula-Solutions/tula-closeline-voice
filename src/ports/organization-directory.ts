/** What the Lines routes need to know about an Organization's people, held by the core service. */
export type OrganizationDirectory = {
  /** Whether the Team exists in the Organization. */
  teamExists: (organizationId: string, teamId: string) => Promise<boolean>
  /** Whether the Membership exists in the Organization and holds the Rep role. */
  isRep: (organizationId: string, membershipId: string) => Promise<boolean>
  /** The Membership id the User holds in the Organization, or undefined when they hold none. */
  membershipOf: (organizationId: string, userId: string) => Promise<string | undefined>
}
