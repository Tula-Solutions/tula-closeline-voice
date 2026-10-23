/** A number the telephony provider has handed over, or will once a port completes. */
export type ProvisionedNumber = {
  /** The number in E.164 form. */
  number: string
  /** The ISO 3166-1 alpha-2 country the number belongs to. */
  country: string
  /** The provider's id for the number. */
  providerSid: string
  /** `porting` while a port is under way, `active` once the number can place and take Calls. */
  state: 'porting' | 'active'
}

/** What the Admin asked for when buying a new number. */
export type BuyRequest = { country: string; areaCode?: string | undefined }

/**
 * How long add-Line waits for the provider before it gives up, in milliseconds. It sits well under
 * the 60s after which the database closes a transaction that is idle, because add-Line holds one
 * open across the buy or port.
 */
export const NUMBER_PROVISIONER_TIMEOUT_MS = 15_000

/**
 * Buys, ports and releases phone numbers at the telephony provider. Every call takes an abort
 * signal and must reject once it fires, so a caller can bound the time it waits.
 */
export type NumberProvisioner = {
  /** Buys a number in `country`, optionally within an area code. */
  buy: (request: BuyRequest, signal: AbortSignal) => Promise<ProvisionedNumber>
  /** Starts porting a number the Organization already owns in. */
  port: (number: string, signal: AbortSignal) => Promise<ProvisionedNumber>
  /** Gives the number back to the provider. Releasing a number already gone succeeds. */
  release: (providerSid: string, signal: AbortSignal) => Promise<void>
}
