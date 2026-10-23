import { formatId } from 'tula-closeline-contract'
import {
  createMemoryTwilioStore,
  createTwilioTelephony,
  signTwilioRequest,
  type TelephonyPort,
} from 'tula-closeline-kit'

/** The origin the test app believes it is reached on; the signed URL is built from it. */
export const TEST_BASE_URL = 'http://voice.test'
/** A made-up auth token: the adapter signs and verifies with it, nothing real. */
export const TEST_AUTH_TOKEN = 'test-auth-token-0123456789abcdef'

/** A Twilio adapter over a fetch that must never be called, so a test cannot reach a network. */
export function createStubbedTwilio(): TelephonyPort {
  return createTwilioTelephony({
    accountSid: `AC${'a'.repeat(32)}`,
    apiKeySid: `SK${'b'.repeat(32)}`,
    apiKeySecret: 'test-api-key-secret-0123456789',
    authToken: TEST_AUTH_TOKEN,
    twimlAppSid: `AP${'c'.repeat(32)}`,
    environment: 'local',
    statusCallbackUrl: `${TEST_BASE_URL}/webhooks/twilio/status`,
    recordingStatusCallbackUrl: `${TEST_BASE_URL}/webhooks/twilio/recording`,
    store: createMemoryTwilioStore(),
    fetch: async () => {
      throw new Error('the webhook tests make no outbound call')
    },
  })
}

/** A fresh Call id. */
export const newCallId = (): string => formatId('call', crypto.randomUUID().replaceAll('-', ''))

/** What a signed Twilio request looks like to the app: the path with its query, headers and body. */
export type SignedRequest = { path: string; init: RequestInit; body: string }

/** Builds a request Twilio would send for `params`, signed over the URL the app rebuilds. */
export function signedRequest(
  path: string,
  params: Record<string, string>,
  options: { token?: string; headers?: Record<string, string>; signature?: string | null } = {}
): SignedRequest {
  const body = new URLSearchParams(params).toString()
  const signature =
    options.signature === undefined
      ? signTwilioRequest(TEST_AUTH_TOKEN, `${TEST_BASE_URL}${path}`, params)
      : options.signature
  return {
    path,
    body,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(signature === null ? {} : { 'x-twilio-signature': signature }),
        ...(options.token ? { 'i-twilio-idempotency-token': options.token } : {}),
        ...options.headers,
      },
      body,
    },
  }
}
