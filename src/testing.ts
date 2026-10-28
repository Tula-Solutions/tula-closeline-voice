import type { Hono } from 'hono'
import { formatId, type OrganizationId, type Role, type UserId } from 'tula-closeline-contract'
import {
  createFixedClock,
  createLogger,
  createStaticKeySet,
  createTokenVerifier,
  type FixedClock,
  TELEPHONY_ERROR_CODES,
  TelephonyError,
  type TelephonyPort,
  TokenVerificationError,
  type TokenVerifier,
} from 'tula-closeline-kit'
import {
  createMemoryContactGuard,
  createMemoryLlm,
  createMemoryObjectStore,
  createMemoryQueue,
  createMemoryStreamingTranscribe,
  createMemoryTelephony,
  createTestJwks,
  createTestKeyPair,
  type MemoryContactGuard,
  type MemoryLlm,
  type MemoryObjectStore,
  type MemoryQueue,
  type MemoryStreamingTranscribe,
  type MemoryTelephony,
  mintTestToken,
} from 'tula-closeline-kit/testing'
import {
  createMemoryAgentCallStore,
  type MemoryAgentCallStore,
} from '~/adapters/memory/agent-call-store'
import { createMemoryAgentSettingsStore } from '~/adapters/memory/agent-settings-store'
import { createMemoryAgentTurnStore } from '~/adapters/memory/agent-turn-store'
import {
  createMemoryBookingGateway,
  type MemoryBookingGateway,
} from '~/adapters/memory/booking-gateway'
import {
  createMemoryCallEventStore,
  type MemoryCallEventStore,
} from '~/adapters/memory/call-event-store'
import { createMemoryCallStore, type MemoryCallStore } from '~/adapters/memory/call-store'
import { createMemoryCallTurnStore } from '~/adapters/memory/call-turn-store'
import {
  createMemoryChatSites,
  createMemoryConsentRecorder,
  type MemoryChatSites,
  type MemoryConsentRecorder,
} from '~/adapters/memory/chat-sites'
import { createMemoryChatStore } from '~/adapters/memory/chat-store'
import { createMemoryCopilotCardStore } from '~/adapters/memory/copilot-card-store'
import {
  createMemoryEvidenceSearch,
  type MemoryEvidenceSearch,
} from '~/adapters/memory/evidence-search'
import { createMemoryHandoffStore } from '~/adapters/memory/handoff-store'
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
import {
  createMemoryProspectDirectory,
  type MemoryProspectDirectory,
} from '~/adapters/memory/prospect-directory'
import { createMemoryQualificationQuestionStore } from '~/adapters/memory/qualification-question-store'
import {
  createMemoryQualificationStore,
  type MemoryQualificationStore,
} from '~/adapters/memory/qualification-store'
import { createMemoryRecordingStore } from '~/adapters/memory/recording-store'
import { createApp } from '~/app'
import type { Container, ErrorContext, ReadinessCheck } from '~/container'
import { loadEnv } from '~/env'
import { SERVICE } from '~/info'
import { idle } from '~/modules/call/service'
import { publishOnFinal } from '~/modules/recording/jobs'
import {
  type callEndedMessage,
  eventRegistry,
  type finishRecordingMessage,
  jobRegistry,
} from '~/modules/recording/messages'
import { createCopilotRuntime } from '~/modules/transcript/runtime'
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
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/voice-jobs',
  PHONE_HASH_KEY: 'phone-hash-key-0123456789-abcdefghijklmnop',
  STORAGE_BUCKET: 'closeline-voice-test',
  CORE_INTERNAL_URL: 'https://core.test',
  CORE_INTERNAL_TOKEN: 'core-internal-token-0123456789',
  INTERNAL_API_TOKENS: 'voice-internal-token-0123456789-abcdefgh',
  PLAYBOOK_INTERNAL_URL: 'https://playbook.internal',
  PLAYBOOK_INTERNAL_TOKEN: 'playbook-internal-token-0123456789',
  TELEPHONY_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'api-key-secret-0123456789',
  TWILIO_AUTH_TOKEN: 'auth-token-0123456789abcdef',
  TWILIO_TWIML_APP_SID: `AP${'c'.repeat(32)}`,
  WEBHOOK_BASE_URL: 'https://voice.example',
  STT_PRICE_MICRO_CENTS_PER_SECOND: '4000',
  TTS_PRICE_MICRO_CENTS_PER_CHARACTER: '1500',
  LLM_INPUT_PRICE_MICRO_CENTS_PER_TOKEN: '30',
  LLM_OUTPUT_PRICE_MICRO_CENTS_PER_TOKEN: '150',
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
  llm: MemoryLlm
  transcribe: MemoryStreamingTranscribe
  evidence: MemoryEvidenceSearch
  idempotency: MemoryIdempotencyStore
  chatSites: MemoryChatSites
  consents: MemoryConsentRecorder
  numbers: MemoryNumberProvisioner
  directory: MemoryOrganizationDirectory
  qualification: MemoryQualificationStore
  booking: MemoryBookingGateway
  agentCalls: MemoryAgentCallStore
  prospects: MemoryProspectDirectory
  contactGuard: MemoryContactGuard
  callEvents: MemoryCallEventStore
  calls: MemoryCallStore
  storage: MemoryObjectStore
  events: MemoryQueue<typeof callEndedMessage>
  jobs: MemoryQueue<typeof finishRecordingMessage>
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

  const clock = createFixedClock('2026-01-01T00:00:00Z')
  const jobs = createMemoryQueue({ registry: jobRegistry, clock })
  const logger = createLogger({
    service: SERVICE,
    level: 'debug',
    destination: { write: (line) => void logLines.push(line) },
  })
  const calls = publishOnFinal(createMemoryCallStore(), jobs, logger)
  return {
    env: loadEnv({
      ENVIRONMENT: 'local',
      LOG_LEVEL: 'debug',
      ...(overrides.env?.ENVIRONMENT && overrides.env.ENVIRONMENT !== 'local' ? DEPLOYED_ENV : {}),
      ...overrides.env,
    }),
    logger,
    clock,
    tokenVerifier: overrides.tokenVerifier ?? REJECTING_VERIFIER,
    lines: createMemoryLineStore(),
    agentCalls: createMemoryAgentCallStore(),
    prospects: createMemoryProspectDirectory(),
    contactGuard: createMemoryContactGuard(),
    agentSettings: createMemoryAgentSettingsStore(),
    questions: createMemoryQualificationQuestionStore(),
    qualification: createMemoryQualificationStore(),
    booking: createMemoryBookingGateway(),
    turns: createMemoryAgentTurnStore(
      () => new Date(),
      (org, id, n) => calls.addAgentCost(org, id, n)
    ),
    handoffs: createMemoryHandoffStore(),
    sleep: async () => undefined,
    evidence: createMemoryEvidenceSearch(),
    llm: createMemoryLlm({ sleep: async () => undefined, random: () => 0 }),
    idempotency: createMemoryIdempotencyStore(),
    chats: createMemoryChatStore(),
    chatSites: createMemoryChatSites(),
    consents: createMemoryConsentRecorder(),
    numbers: createMemoryNumberProvisioner(),
    numberTimeoutMs: NUMBER_PROVISIONER_TIMEOUT_MS,
    telephony: overrides.telephony ?? createMemoryTelephony(),
    callEvents: createMemoryCallEventStore(),
    calls,
    recordings: createMemoryRecordingStore(),
    storage: createMemoryObjectStore({ clock }),
    events: createMemoryQueue({ registry: eventRegistry, clock }),
    jobs,
    callTurns: createMemoryCallTurnStore(),
    copilotCards: createMemoryCopilotCardStore(),
    transcribe: createMemoryStreamingTranscribe({ sleep: async () => undefined, random: () => 0 }),
    copilot: createCopilotRuntime(5),
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
  // Presigned URLs expire by the clock the test advances.
  deps.storage = createMemoryObjectStore({ clock })
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
      // Buying a Line needs an Idempotency-Key; a fresh one keeps each call a new purchase.
      const key: Record<string, string> =
        method === 'POST' && path === '/lines' ? { 'idempotency-key': crypto.randomUUID() } : {}
      const response = await app.request(`/v1${path}`, {
        method,
        headers: {
          ...(await bearer(identity)),
          ...key,
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

/**
 * Wraps a memory telephony so a dialled call behaves like real Twilio: it rings, and the
 * Disclosure, the bridge and the Recording are refused (`callEnded`) until `answer` is called.
 */
export function ringUntilAnswered(inner: MemoryTelephony): MemoryTelephony & {
  /** Marks the provider call answered, as the Prospect picking up does. */
  answer: (providerCallId: string) => void
} {
  const answered = new Set<string>()
  const gated =
    (name: 'playDisclosure' | 'bridge' | 'startRecording') =>
    (request: { providerCallId: string }, ...rest: unknown[]) => {
      if (!answered.has(request.providerCallId)) {
        throw new TelephonyError(TELEPHONY_ERROR_CODES.callEnded, 'the call is not answered')
      }
      return (inner[name] as (...args: unknown[]) => unknown)(request, ...rest)
    }
  const overrides: Record<string | symbol, unknown> = {
    playDisclosure: gated('playDisclosure'),
    bridge: gated('bridge'),
    startRecording: gated('startRecording'),
    answer: (providerCallId: string) => void answered.add(providerCallId),
  }
  return new Proxy(inner, {
    get: (target, prop) => (prop in overrides ? overrides[prop] : Reflect.get(target, prop)),
  }) as never
}

/**
 * Delivers the status callback the provider sends for a Call, signed as the telephony would sign
 * it, then waits for the background setup it may start. Returns the HTTP status.
 */
export async function reportStatus(
  t: TestApp,
  telephony: Pick<MemoryTelephony, 'sign'>,
  organizationId: string,
  callId: string,
  callStatus: string,
  sequence = '1'
): Promise<number> {
  const stored = await t.deps.calls.get(organizationId as never, callId as never)
  t.deps.callEvents.addCall(organizationId, callId)
  const pathAndQuery = `/webhooks/twilio/status?organizationId=${organizationId}&callId=${callId}`
  const body = new URLSearchParams({
    CallSid: stored?.providerCallSid ?? 'CAunknown',
    CallStatus: callStatus,
    SequenceNumber: sequence,
    Timestamp: 'Thu, 01 Jan 2026 00:00:05 +0000',
  }).toString()
  const url = `${t.deps.env.WEBHOOK_BASE_URL ?? 'http://localhost'}${pathAndQuery}`
  const response = await t.app.request(pathAndQuery, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': telephony.sign(url, body),
    },
    body,
  })
  await idle()
  return response.status
}
