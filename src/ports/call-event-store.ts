/** One thing the telephony provider reported about a Call, as it is stored in the Call's log. */
export type ProviderCallbackRecord = {
  organizationId: string
  /** Our Call id, read from the signed callback URL. */
  callId: string
  /** The provider's id of the event: the key webhooks are idempotent by. 1 to 200 characters. */
  providerEventId: string
  /** When the provider says it happened. */
  occurredAt: Date
}

/** What recording a provider callback did. */
export type RecordResult =
  /** The event was new and is now in the Call's log. */
  | 'recorded'
  /** The same provider event id had been recorded already; nothing changed. */
  | 'duplicate'
  /** The Organization has no such Call; nothing changed. */
  | 'unknown_call'

/** The Call event log, the only place provider callbacks are written; idempotent by provider event id. */
export type CallEventStore = {
  /** Appends the callback to its Call's log unless that provider event id is already there. */
  recordProviderCallback: (record: ProviderCallbackRecord) => Promise<RecordResult>
}
