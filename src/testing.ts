import type { Hono } from 'hono'
import { formatId, type OrganizationId, type Role, type UserId } from 'tula-closeline-contract'
import {
  createFixedClock,
  createLogger,
  createStaticKeySet,
  createTokenVerifier,
  type FixedClock,
  type TelephonyPort,
  TokenVerificationError,
  type TokenVerifier,
} from 'tula-closeline-kit'
import {
  createMemoryTelephony,
  createTestJwks,
  createTestKeyPair,
  mintTestToken,
} from 'tula-closeline-kit/testing'
import { createMemoryAgentSettingsStore } from '~/adapters/memory/agent-settings-store'
import {
  createMemoryCallEventStore,
  type MemoryCallEventStore,
} from '~/adapters/memory/call-event-store'
import { createMemoryCallStore, type MemoryCallStore } from '~/adapters/memory/call-store'
import {
  createMemoryIdempotencyStore,
  type MemoryIdempotencyStore,
} from '~/adapters/memory/idempotency-store'
import { createMemoryLineStore } from '~/adapters/memory/line-store'
import {
  createMemoryNumberProvisioner,
  type MemoryNumberProvisioner,
} from '~/adapters/memory/number-provisioner'
import {
  createMemoryOrganizationDirectory,
  type MemoryOrganizationDirectory,
} from '~/adapters/memory/organization-directory'
import { createMemoryQualificationQuestionStore } from '~/adapters/memory/qualification-question-store'
import { createApp } from '~/app'
import type { Container, ErrorContext, ReadinessCheck } from '~/container'
import { loadEnv } from '~/env'
import { SERVICE } from '~/info'
import { NUMBER_PROVISIONER_TIMEOUT_MS } from '~/ports/number-provisioner'

/** Every key a deployed environment must set, so a test can run as any ENVIRONMENT. */
const DEPLOYED_ENV: Readonly<Record<string, string>> = {
  REGION: 'us',
  DATABASE_URL: 'postgres://closeline_voice:secret@db.test:5432/closeline',
  AUTH_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
  AUTH_ISSUER: 'https://auth.test',
  AUTH_AUDIENCE: 'closeline',
  AWS_REGION: 'us-east-1',
  QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/voice',
  STORAGE_BUCKET: 'closeline-voice-test',
  CORE_INTERNAL_URL: 'https://core.test',
  CORE_INTERNAL_TOKEN: 'core-internal-token-0123456789',
  TELEPHONY_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'api-key-secret-0123456789',
  TWILIO_AUTH_TOKEN: 'auth-token-0123456789abcdef',
  TWILIO_TWIML_APP_SID: `AP${'c'.repeat(32)}`,
  WEBHOOK_BASE_URL: 'https://voice.example',
}

/** A verifier that accepts nothing, for a test that never sends a token. */
const REJECTING_VERIFIER: TokenVerifier = {
  verify: async () => {
    throw new TokenVerificationError('invalid')
  },
}

/** The container plus the observable side effects a test asserts on. */
export type TestDeps = Container & {
  clock: FixedClock
  idempotency: MemoryIdempotencyStore
  numbers: MemoryNumberProvisioner
  directory: MemoryOrganizationDirectory
  callEvents: MemoryCallEventStore
  calls: MemoryCallStore
  /** Every JSON log line written, in order. */
  logLines: string[]
  /** Every call to `reportError`, in order. */
  reported: { error: unknown; context: ErrorContext }[]
}

/** What a test may replace in {@link createTestDeps}. */
export type TestDepsOverrides = {
  readinessChecks?: readonly ReadinessCheck[]
  env?: Record<string, string>
  tokenVerifier?: TokenVerifier
  /** Replaces the telephony adapter, e.g. with the real Twilio adapter over a stubbed fetch. */
  telephony?: TelephonyPort
}

/** Builds a container of in-memory doubles and a fixed clock; `overrides` replace any field. */
export function createTestDeps(overrides: TestDepsOverrides = {}): TestDeps {
  const logLines: string[] = []
  const reported: TestDeps['reported'] = []

  return {
    env: loadEnv({
      ENVIRONMENT: 'local',
      LOG_LEVEL: 'debug',
      ...(overrides.env?.ENVIRONMENT && overrides.env.ENVIRONMENT !== 'local' ? DEPLOYED_ENV : {}),
      ...overrides.env,
    }),
    logger: createLogger({
      service: SERVICE,
      level: 'debug',
      destination: { write: (line) => void logLines.push(line) },
    }),
    clock: createFixedClock('2026-01-01T00:00:00Z'),
    tokenVerifier: overrides.tokenVerifier ?? REJECTING_VERIFIER,
    lines: createMemoryLineStore(),
    agentSettings: createMemoryAgentSettingsStore(),
    questions: createMemoryQualificationQuestionStore(),
    idempotency: createMemoryIdempotencyStore(),
    numbers: createMemoryNumberProvisioner(),
    numberTimeoutMs: NUMBER_PROVISIONER_TIMEOUT_MS,
    telephony: overrides.telephony ?? createMemoryTelephony(),
    callEvents: createMemoryCallEventStore(),
    calls: createMemoryCallStore(),
    directory: createMemoryOrganizationDirectory(),
    close: async () => undefined,
    readinessChecks: overrides.readinessChecks ?? [],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      reported.push({ error, context })
    },
    logLines,
    reported,
  }
}

/** Who a test calls as: the claims of the access token it mints. */
export type TestIdentity = { userId: UserId; organizationId: OrganizationId; role: Role }

/** The app under test, its doubles, and the helpers that call it as someone. */
export type TestApp = {
  app: Hono<never>
  deps: TestDeps
  /** The `authorization` header of a freshly minted access token for `identity`. */
  bearer: (identity: TestIdentity) => Promise<{ authorization: string }>
  /** Calls `/v1${path}` as `identity` and returns the status and the parsed body. */
  call: (
    identity: TestIdentity,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: unknown }>
}

/** Builds the real app over in-memory doubles with a working token verifier. */
export async function createTestApp(overrides: TestDepsOverrides = {}): Promise<TestApp> {
  const keyPair = await createTestKeyPair()
  const clock = createFixedClock('2026-01-01T00:00:00Z')
  const verifier = createTokenVerifier({
    issuer: 'https://auth.test',
    audience: 'closeline',
    keys: await createStaticKeySet(createTestJwks(keyPair)),
    clock,
  })
  const deps = createTestDeps({
    tokenVerifier: verifier,
    env: { AUTH_ISSUER: 'https://auth.test', AUTH_AUDIENCE: 'closeline', ...overrides.env },
    ...(overrides.readinessChecks ? { readinessChecks: overrides.readinessChecks } : {}),
    ...(overrides.telephony ? { telephony: overrides.telephony } : {}),
  })
  // Tokens are minted and verified at the same instant, whatever the test advances the clock to.
  deps.clock = clock
  const app = createApp(deps) as unknown as Hono<never>

  const bearer: TestApp['bearer'] = async (identity) => ({
    authorization: `Bearer ${await mintTestToken({
      keyPair,
      clock,
      claims: { sub: identity.userId, org: identity.organizationId, role: identity.role },
    })}`,
  })

  return {
    app,
    deps,
    bearer,
    call: async (identity, method, path, body) => {
      const response = await app.request(`/v1${path}`, {
        method,
        headers: {
          ...(await bearer(identity)),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
    },
  }
}

/** A fresh User id. */
export const newUserId = (): UserId => formatId('usr', crypto.randomUUID())

/** A fresh Organization id. */
export const newOrganizationId = (): OrganizationId => formatId('org', crypto.randomUUID())

/** An identity with the role in a fresh or given Organization. */
export function identityOf(role: Role, organizationId = newOrganizationId()): TestIdentity {
  return { userId: newUserId(), organizationId, role }
}
