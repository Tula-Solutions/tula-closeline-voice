import { expect, test } from 'bun:test'
import { loadEnv } from './env'

test('configuration falls back to defaults for everything but the environment', () => {
  expect(loadEnv({ ENVIRONMENT: 'local' })).toEqual({
    ENVIRONMENT: 'local',
    PORT: 3000,
    LOG_LEVEL: 'info',
    READINESS_TIMEOUT_MS: 2_000,
    SHUTDOWN_TIMEOUT_MS: 10_000,
    SHUTDOWN_GRACE_MS: 5_000,
    MAX_REQUEST_BODY_BYTES: 1_048_576,
    REGION: 'us',
    DATABASE_URL: 'postgres://closeline_voice:closeline_voice_local@127.0.0.1:5432/closeline',
    AUTH_JWKS_URL: 'http://127.0.0.1:3001/.well-known/jwks.json',
    AUTH_ISSUER: 'http://127.0.0.1:3001',
    AUTH_AUDIENCE: 'closeline',
    AWS_REGION: 'us-east-1',
    TELEPHONY_PROVIDER: 'memory',
    TWILIO_PURGE_INTERVAL_MS: 900_000,
    TWILIO_PURGE_MAX_ORGANIZATIONS: 200,
  })
})

test('the purge interval and Organization cap are bounded', () => {
  const at = (extra: Record<string, string>) => loadEnv({ ENVIRONMENT: 'local', ...extra })
  expect(at({ TWILIO_PURGE_INTERVAL_MS: '60000' }).TWILIO_PURGE_INTERVAL_MS).toBe(60_000)
  expect(() => at({ TWILIO_PURGE_INTERVAL_MS: '10' })).toThrow()
  expect(() => at({ TWILIO_PURGE_MAX_ORGANIZATIONS: '0' })).toThrow()
})

const DEPLOYED = {
  REGION: 'us',
  DATABASE_URL: 'postgres://closeline_voice:secret@db.internal:5432/closeline',
  AUTH_JWKS_URL: 'https://auth.example/.well-known/jwks.json',
  AUTH_ISSUER: 'https://auth.example',
  AUTH_AUDIENCE: 'closeline',
  AWS_REGION: 'us-east-1',
  QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/voice-events',
  STORAGE_BUCKET: 'closeline-voice-recordings',
  CORE_INTERNAL_URL: 'https://core.internal',
  CORE_INTERNAL_TOKEN: 'core-internal-token-0123456789',
  TELEPHONY_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'api-key-secret-0123456789',
  TWILIO_AUTH_TOKEN: 'auth-token-0123456789abcdef',
  TWILIO_TWIML_APP_SID: `AP${'c'.repeat(32)}`,
  WEBHOOK_BASE_URL: 'https://voice.example',
}

test('a deployed environment accepts the full set of keys', () => {
  expect(loadEnv({ ENVIRONMENT: 'prod', ...DEPLOYED })).toMatchObject({
    ENVIRONMENT: 'prod',
    REGION: 'us',
    TELEPHONY_PROVIDER: 'twilio',
  })
})

test.each(Object.keys(DEPLOYED))('a deployed environment without %s fails at boot', (key) => {
  const source: Record<string, string> = { ENVIRONMENT: 'staging', ...DEPLOYED }
  delete source[key]
  expect(() => loadEnv(source)).toThrow(key)
})

test('the core link is optional when local but must be set together and be https elsewhere', () => {
  expect(loadEnv({ ENVIRONMENT: 'local' }).CORE_INTERNAL_URL).toBeUndefined()
  expect(
    loadEnv({
      ENVIRONMENT: 'local',
      CORE_INTERNAL_URL: 'http://127.0.0.1:3002',
      CORE_INTERNAL_TOKEN: 'core-internal-token-0123456789',
    }).CORE_INTERNAL_URL
  ).toBe('http://127.0.0.1:3002')
  expect(() =>
    loadEnv({ ENVIRONMENT: 'local', CORE_INTERNAL_URL: 'http://127.0.0.1:3002' })
  ).toThrow('CORE_INTERNAL_TOKEN')
  expect(() =>
    loadEnv({ ENVIRONMENT: 'local', CORE_INTERNAL_TOKEN: 'core-internal-token-0123456789' })
  ).toThrow('CORE_INTERNAL_URL')
  expect(() =>
    loadEnv({ ENVIRONMENT: 'prod', ...DEPLOYED, CORE_INTERNAL_URL: 'http://core.internal' })
  ).toThrow('CORE_INTERNAL_URL must be https')
  expect(() => loadEnv({ ENVIRONMENT: 'prod', ...DEPLOYED, CORE_INTERNAL_TOKEN: 'short' })).toThrow(
    'CORE_INTERNAL_TOKEN'
  )
})

test('the in-memory telephony provider is accepted only when local', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'dev', ...DEPLOYED, TELEPHONY_PROVIDER: 'memory' })).toThrow(
    'TELEPHONY_PROVIDER'
  )
})

test('local stand-in endpoints are accepted only when local and need their resource', () => {
  expect(() =>
    loadEnv({ ENVIRONMENT: 'prod', ...DEPLOYED, QUEUE_ENDPOINT: 'http://127.0.0.1:9324' })
  ).toThrow('QUEUE_ENDPOINT')
  expect(() => loadEnv({ ENVIRONMENT: 'local', QUEUE_ENDPOINT: 'http://127.0.0.1:9324' })).toThrow(
    'QUEUE_URL'
  )
  expect(() =>
    loadEnv({ ENVIRONMENT: 'prod', ...DEPLOYED, STORAGE_ENDPOINT: 'http://127.0.0.1:9090' })
  ).toThrow('STORAGE_ENDPOINT')
  expect(() =>
    loadEnv({ ENVIRONMENT: 'local', STORAGE_ENDPOINT: 'http://127.0.0.1:9090' })
  ).toThrow('STORAGE_BUCKET')
})

test('an unknown Region and a non-postgres database URL are rejected', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', REGION: 'mars' })).toThrow()
  expect(() => loadEnv({ ENVIRONMENT: 'local', DATABASE_URL: 'mysql://x' })).toThrow()
})

test('a deploy without ENVIRONMENT fails at boot instead of running as local', () => {
  expect(() => loadEnv({})).toThrow()
})

test.each([
  ['an unknown environment', { ENVIRONMENT: 'production' }],
  ['an unknown log level', { LOG_LEVEL: 'verbose' }],
  ['a port out of range', { PORT: '70000' }],
  ['a zero readiness timeout', { READINESS_TIMEOUT_MS: '0' }],
  ['a non-numeric shutdown timeout', { SHUTDOWN_TIMEOUT_MS: 'soon' }],
  ['a negative shutdown grace', { SHUTDOWN_GRACE_MS: '-1' }],
  ['a zero body limit', { MAX_REQUEST_BODY_BYTES: '0' }],
  ['a body limit above 100 MB', { MAX_REQUEST_BODY_BYTES: '104857601' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', ...source })).toThrow()
})

test('a grace period plus drain timeout above 60 s is rejected, naming both keys', () => {
  const source = { ENVIRONMENT: 'local', SHUTDOWN_GRACE_MS: '30001', SHUTDOWN_TIMEOUT_MS: '30000' }

  expect(() => loadEnv(source)).toThrow(/SHUTDOWN_GRACE_MS.*SHUTDOWN_TIMEOUT_MS/s)
})

test('a grace period plus drain timeout of exactly 60 s is accepted', () => {
  const env = loadEnv({
    ENVIRONMENT: 'local',
    SHUTDOWN_GRACE_MS: '30000',
    SHUTDOWN_TIMEOUT_MS: '30000',
  })

  expect(env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS).toBe(60_000)
})

test('twilio needs its credentials and an https origin to be reached on', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', TELEPHONY_PROVIDER: 'twilio' })).toThrow(
    'TWILIO_AUTH_TOKEN'
  )
  expect(() =>
    loadEnv({ ENVIRONMENT: 'prod', ...DEPLOYED, WEBHOOK_BASE_URL: 'http://voice.example' })
  ).toThrow('WEBHOOK_BASE_URL')
  expect(() =>
    loadEnv({ ENVIRONMENT: 'prod', ...DEPLOYED, WEBHOOK_BASE_URL: 'https://voice.example/hooks' })
  ).toThrow('origin only')
  expect(() =>
    loadEnv({ ENVIRONMENT: 'prod', ...DEPLOYED, TWILIO_ACCOUNT_SID: 'not-a-sid' })
  ).toThrow('TWILIO_ACCOUNT_SID')
  expect(
    loadEnv({
      ENVIRONMENT: 'local',
      ...DEPLOYED,
      WEBHOOK_BASE_URL: 'http://127.0.0.1:3000',
      TWILIO_REGION: 'ie1',
    })
  ).toMatchObject({ TWILIO_REGION: 'ie1' })
})
