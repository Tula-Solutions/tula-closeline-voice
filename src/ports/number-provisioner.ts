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

/** Buys, ports and releases phone numbers at the telephony provider. */
export type NumberProvisioner = {
  /** Buys a number in `country`, optionally within an area code. */
  buy: (request: BuyRequest) => Promise<ProvisionedNumber>
  /** Starts porting a number the Organization already owns in. */
  port: (number: string) => Promise<ProvisionedNumber>
  /** Gives the number back to the provider. Releasing a number already gone succeeds. */
  release: (providerSid: string) => Promise<void>
}
