/** Who asks: the Rep route passes the caller so visibility applies; the internal route passes none. */
export type ProspectViewer = { userId: string; role: string }

/** What the gate needs to know about a Prospect: how to reach them and where they are. */
export type ProspectContact = {
  /** The Prospect's number in E.164, or `null` when they have none. */
  phone: string | null
  /** A known IANA zone for the Prospect, when core has one. */
  timeZone: string | null
}

/**
 * Prospects of an Organization, held by core, which this service never reads directly. A Prospect
 * that is missing, or that the viewer may not see, is `undefined`.
 */
export type ProspectDirectory = {
  /** The Prospect's contact, as the viewer may see it. */
  lookup: (
    organizationId: string,
    prospectId: string,
    viewer?: ProspectViewer
  ) => Promise<ProspectContact | undefined>
}
