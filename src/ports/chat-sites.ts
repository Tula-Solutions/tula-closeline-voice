/** What a publishable key stands for: whose website may chat, from where, and what consent it shows. */
export type ChatSite = {
  organizationId: string
  /** The origins allowed to start and use a Chat, such as `https://example.com`. */
  allowedOrigins: readonly string[]
  /** The Consent Wording (id and version) the Chat's callback box currently shows. */
  wording: { id: string; version: number }
}

/** The widget configuration of every Organization, held by the intake (Inquiry) settings. */
export type ChatSites = {
  /** The site a publishable key belongs to, or undefined when the key is unknown or revoked. */
  ofKey: (key: string) => Promise<ChatSite | undefined>
  /** The Organization's site, or undefined when it has none. */
  ofOrganization: (organizationId: string) => Promise<ChatSite | undefined>
}

/** What a callback request in a Chat asks core to record. */
export type ConsentRequest = {
  organizationId: string
  /** One per Chat: core answers a repeat with the first result. */
  idempotencyKey: string
  name: string
  phone: string
  wordingId: string
  wordingVersion: number
  /** Whether the visitor agreed to a phone callback. */
  agreed: boolean
  sourceUrl: string
  at: Date
}

/** Upserts the Prospect and records the Contact Consent for the phone channel, in core. */
export type ConsentRecorder = {
  /** Records the request and returns the Prospect's id. Fails closed when core cannot be reached. */
  record: (request: ConsentRequest) => Promise<{ prospectId: string }>
}
