import { ERRORS, VOICE_ERRORS } from 'tula-closeline-contract'
import { domainError } from '~/http/domain-error'
import type { NumberProvisioner, ProvisionedNumber } from '~/ports/number-provisioner'

/** The friendly name Closeline gives a number it buys; `release` deletes only numbers carrying it. */
export const BOUGHT_BY_CLOSELINE = 'Closeline (bought)'
/** The longest one attempt at Twilio may take, in milliseconds. */
export const TWILIO_NUMBERS_ATTEMPT_TIMEOUT_MS = 5_000
/** Attempts for a read (the first plus retries); a write is always one. */
export const TWILIO_NUMBERS_READ_ATTEMPTS = 3
/** The most of an answer read, in bytes. */
const MAX_RESPONSE_BYTES = 1_048_576
const BACKOFF_BASE_MS = 100
/** Twilio codes for "that number cannot be had" (not available, no numbers match). */
const UNAVAILABLE_TWILIO_CODES = new Set([21422, 21452])
/** Dialling codes for the countries voice sells numbers in; the account record carries no country. */
const COUNTRY_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['+44', 'GB'],
  ['+49', 'DE'],
  ['+1', 'US'],
]

/** Options for {@link createTwilioNumberProvisioner}. */
export type TwilioNumberProvisionerOptions = {
  accountSid: string
  apiKeySid: string
  /** Never logged. */
  apiKeySecret: string
  /** The public https origin Twilio posts Calls to; the inbound webhook hangs off it. */
  webhookBaseUrl: string
  /** Defaults to `https://api.twilio.com`. */
  baseUrl?: string
  /** The HTTP client; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Per-attempt timeout; defaults to {@link TWILIO_NUMBERS_ATTEMPT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Waits between read attempts; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
  /** Jitter source in [0, 1); defaults to `Math.random`. */
  random?: () => number
}

type Json = Record<string, unknown>
type Reply = { status: number; json: Json }

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const first = (json: Json, key: string): Json | undefined => {
  const list = json[key]
  const head = Array.isArray(list) ? (list[0] as unknown) : undefined
  return typeof head === 'object' && head !== null ? (head as Json) : undefined
}

/** A provisioner over Twilio's REST API (API key over basic auth); the purchase is never retried. */
export function createTwilioNumberProvisioner(
  options: TwilioNumberProvisionerOptions
): NumberProvisioner {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? TWILIO_NUMBERS_ATTEMPT_TIMEOUT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random
  const account = `${options.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${options.accountSid}`
  const authorization = `Basic ${btoa(`${options.apiKeySid}:${options.apiKeySecret}`)}`
  const voiceUrl = `${options.webhookBaseUrl}/webhooks/twilio/inbound`
  const unavailable = () => domainError(ERRORS['server.unavailable'])

  async function readJson(response: Response): Promise<Json> {
    const reader = response.body?.getReader()
    if (!reader) {
      return {}
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.length
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw unavailable()
      }
      chunks.push(value)
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
      return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : {}
    } catch {
      return {}
    }
  }

  /** One attempt; resolves any status, rejects on a network failure, timeout or abort. */
  async function once(
    method: string,
    path: string,
    signal: AbortSignal,
    form?: Record<string, string>
  ): Promise<Reply> {
    signal.throwIfAborted()
    const response = await doFetch(`${account}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
    return { status: response.status, json: await readJson(response) }
  }

  /** A read: retried with jitter on a network error, timeout or 5xx, never past the caller's abort. */
  async function read(path: string, signal: AbortSignal): Promise<Reply> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const reply = await once('GET', path, signal)
        if (reply.status < 500) {
          return reply
        }
      } catch (error) {
        if (signal.aborted) {
          throw error
        }
      }
      if (attempt >= TWILIO_NUMBERS_READ_ATTEMPTS) {
        throw unavailable()
      }
      await sleep(Math.floor(BACKOFF_BASE_MS * 2 ** (attempt - 1) * (0.5 + random())))
    }
  }

  /** A write: one attempt, so a lost answer is never repeated. */
  async function write(
    method: 'POST' | 'DELETE',
    path: string,
    signal: AbortSignal,
    form?: Record<string, string>
  ): Promise<Reply> {
    try {
      return await once(method, path, signal, form)
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      throw unavailable()
    }
  }

  const toNumber = (json: Json, country: string): ProvisionedNumber => {
    const sid = str(json.sid)
    const number = str(json.phone_number)
    if (!(sid && number)) {
      throw unavailable()
    }
    return { number, country, providerSid: sid, state: 'active' }
  }
  const ok = (reply: Reply) => reply.status >= 200 && reply.status < 300
  const voiceForm = { VoiceUrl: voiceUrl, VoiceMethod: 'POST' }

  return {
    async buy({ country, areaCode }, signal) {
      const query = areaCode ? `?AreaCode=${encodeURIComponent(areaCode)}` : ''
      const found = await read(
        `/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json${query}`,
        signal
      )
      if (!ok(found)) {
        throw unavailable()
      }
      const phoneNumber = str(first(found.json, 'available_phone_numbers')?.phone_number)
      if (!phoneNumber) {
        throw domainError(VOICE_ERRORS['line.number_unavailable'])
      }
      const bought = await write('POST', '/IncomingPhoneNumbers.json', signal, {
        PhoneNumber: phoneNumber,
        FriendlyName: BOUGHT_BY_CLOSELINE,
        ...voiceForm,
      })
      if (!ok(bought)) {
        const code = bought.json.code
        throw typeof code === 'number' && UNAVAILABLE_TWILIO_CODES.has(code)
          ? domainError(VOICE_ERRORS['line.number_unavailable'])
          : unavailable()
      }
      return toNumber(bought.json, country)
    },

    async port(number, signal) {
      // The account record carries no country, so only a known dialling code can be attached.
      const country = COUNTRY_BY_PREFIX.find(([prefix]) => number.startsWith(prefix))?.[1]
      if (!country) {
        throw domainError(VOICE_ERRORS['line.number_unavailable'])
      }
      const found = await read(
        `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
        signal
      )
      if (!ok(found)) {
        throw unavailable()
      }
      const owned = first(found.json, 'incoming_phone_numbers')
      const sid = str(owned?.sid)
      // Real porting is a later ticket: a number outside the account is refused.
      // A number Closeline bought may already be a Line; attaching it again would let a failed
      // insert's release delete it.
      if (!sid || str(owned?.friendly_name) === BOUGHT_BY_CLOSELINE) {
        throw domainError(VOICE_ERRORS['line.number_unavailable'])
      }
      const updated = await write(
        'POST',
        `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`,
        signal,
        voiceForm
      )
      if (!ok(updated)) {
        throw unavailable()
      }
      return toNumber(updated.json, country)
    },

    async release(providerSid, signal) {
      const path = `/IncomingPhoneNumbers/${encodeURIComponent(providerSid)}.json`
      const current = await read(path, signal)
      if (current.status === 404) {
        return
      }
      if (!ok(current)) {
        throw unavailable()
      }
      const done =
        str(current.json.friendly_name) === BOUGHT_BY_CLOSELINE
          ? await write('DELETE', path, signal)
          : await write('POST', path, signal, { VoiceUrl: '' })
      if (!(ok(done) || done.status === 404)) {
        throw unavailable()
      }
    },
  }
}
