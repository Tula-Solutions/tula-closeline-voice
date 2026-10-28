import { sql } from 'drizzle-orm'
import type { RequestId } from 'tula-closeline-contract'
import { createDb, type Database } from 'tula-closeline-db'
import {
  type AnyDefinition,
  type Clock,
  type ContactGuard,
  createAssemblyAiStreamingTranscribe,
  createHttpContactGuard,
  createLogger,
  createRemoteKeySet,
  createTokenVerifier,
  createTwilioTelephony,
  type EnvelopeOf,
  type LlmPort,
  type LogDestination,
  type Logger,
  type MessageRegistry,
  type ObjectStore,
  type Queue,
  type StreamingTranscribePort,
  systemClock,
  type TelephonyPort,
  type TokenVerifier,
  type TtsAudioChunk,
  type TtsPort,
} from 'tula-closeline-kit'
import { createBedrockLlm, DEFAULT_BEDROCK_FAST_MODEL } from 'tula-closeline-kit/llm'
import { createSqsQueue } from 'tula-closeline-kit/queue'
import { createS3ObjectStore } from 'tula-closeline-kit/storage'
import {
  createMemoryContactGuard,
  createMemoryObjectStore,
  createMemoryQueue,
  createMemoryStreamingTranscribe,
  createMemoryTelephony,
} from 'tula-closeline-kit/testing'
import { createCoreHttpBookingGateway } from '~/adapters/core-http/booking-gateway'
import { createCoreHttpOrganizationDirectory } from '~/adapters/core-http/organization-directory'
import { createMemoryBookingGateway } from '~/adapters/memory/booking-gateway'
import { createMemoryEvidenceSearch } from '~/adapters/memory/evidence-search'
import { createRunningMemoryNumberProvisioner } from '~/adapters/memory/number-provisioner'
import { createMemoryOrganizationDirectory } from '~/adapters/memory/organization-directory'
import { createMemoryProspectDirectory } from '~/adapters/memory/prospect-directory'
import { createPlaybookHttpEvidenceSearch } from '~/adapters/playbook-http/evidence-search'
import { createPostgresAgentCallStore } from '~/adapters/postgres/agent-call-store'
import { createPostgresAgentSettingsStore } from '~/adapters/postgres/agent-settings-store'
import { createPostgresAgentTurnStore } from '~/adapters/postgres/agent-turn-store'
import { createPostgresCallEventStore } from '~/adapters/postgres/call-event-store'
import { createPostgresCallStore } from '~/adapters/postgres/call-store'
import { createPostgresCallTurnStore } from '~/adapters/postgres/call-turn-store'
import { createPostgresCopilotCardStore } from '~/adapters/postgres/copilot-card-store'
import { createPostgresCopilotSettingsStore } from '~/adapters/postgres/copilot-settings-store'
import { createPostgresHandoffStore } from '~/adapters/postgres/handoff-store'
import { createPostgresIdempotencyStore } from '~/adapters/postgres/idempotency-store'
import { createPostgresLineStore } from '~/adapters/postgres/line-store'
import { createPostgresQualificationQuestionStore } from '~/adapters/postgres/qualification-question-store'
import { createPostgresQualificationStore } from '~/adapters/postgres/qualification-store'
import { createPostgresRecordingStore } from '~/adapters/postgres/recording-store'
import { createPostgresTwilioPurgeSource } from '~/adapters/postgres/twilio-purge-source'
import { createPostgresTwilioStore } from '~/adapters/postgres/twilio-store'
import { createTwilioNumberProvisioner } from '~/adapters/twilio/number-provisioner'
import {
  createUnconfiguredBookingGateway,
  createUnconfiguredContactGuard,
  createUnconfiguredEvidenceSearch,
  createUnconfiguredOrganizationDirectory,
  createUnconfiguredProspectDirectory,
  createUnconfiguredStreamingTranscribe,
} from '~/adapters/unconfigured'
import { describeError } from '~/describe-error'
import { type Env, loadEnv } from '~/env'
import { SERVICE } from '~/info'
import { publishOnFinal } from '~/modules/recording/jobs'
import {
  type EventEnvelope,
  eventRegistry,
  type JobEnvelope,
  jobRegistry,
} from '~/modules/recording/messages'
import { type CopilotRuntime, createCopilotRuntime } from '~/modules/transcript/runtime'
import type { AgentCallStore } from '~/ports/agent-call-store'
import type { AgentSettingsStore } from '~/ports/agent-settings-store'
import type { AgentTurnStore } from '~/ports/agent-turn-store'
import type { BookingGateway } from '~/ports/booking-gateway'
import type { CallEventStore } from '~/ports/call-event-store'
import type { CallStore } from '~/ports/call-store'
import type { CallTurnStore } from '~/ports/call-turn-store'
import type { CopilotCardStore } from '~/ports/copilot-card-store'
import type { CopilotSettingsStore } from '~/ports/copilot-settings-store'
import type { EvidenceSearch } from '~/ports/evidence-search'
import type { HandoffStore } from '~/ports/handoff-store'
import type { IdempotencyStore } from '~/ports/idempotency-store'
import type { LineStore } from '~/ports/line-store'
import { NUMBER_PROVISIONER_TIMEOUT_MS, type NumberProvisioner } from '~/ports/number-provisioner'
import type { OrganizationDirectory } from '~/ports/organization-directory'
import type { ProspectDirectory } from '~/ports/prospect-directory'
import type { QualificationQuestionStore } from '~/ports/qualification-question-store'
import type { QualificationStore } from '~/ports/qualification-store'
import type { RecordingStore } from '~/ports/recording-store'
import type { TwilioPurgeSource } from '~/ports/twilio-purge-source'

/** What an Agent speaks with: the text-to-speech engine and where a Call's audio goes. */
export type AgentAudio = {
  tts: TtsPort
  /** The audio leg of one Call, which receives the Agent's speech in order. */
  sinkFor: (callId: string) => (chunk: TtsAudioChunk) => void
}

/** One dependency probe for `/readyz`: resolve when healthy, reject or stall when not. */
export type ReadinessCheck = {
  /** A short stable name, reported to the caller, never an address or credential. */
  name: string
  /** Probes the dependency; `signal` aborts when the check has run out of time. */
  run: (signal: AbortSignal) => Promise<void>
}

/** What `reportError` is told about the request that failed. */
export type ErrorContext = {
  requestId: RequestId
  method: string
  /** The path only, never the query string, which can carry secrets. */
  path: string
  /** The HTTP status of the response sent to the client, which can differ from the error's own. */
  status: number
}

/** Everything a request needs from outside the process, built once in {@link createContainer}. */
export type Container = {
  env: Env
  logger: Logger
  clock: Clock
  /** Verifies access tokens offline against the auth service's published keys. */
  tokenVerifier: TokenVerifier
  /** The Lines of every Organization; the only way a module reaches the `voice` schema. */
  lines: LineStore
  /** Agent Call requests of every Organization, with the counts the gate reads. */
  agentCalls: AgentCallStore
  /** How to reach a Prospect and whether a viewer may see them, held by core. */
  prospects: ProspectDirectory
  /** The Contact Check every Agent Call passes (ADR 0003); there is no way to skip it. */
  contactGuard: ContactGuard
  /** The Inbound Agent settings of every Organization, one row each. */
  agentSettings: AgentSettingsStore
  /** The Copilot settings of every Organization, one row each. */
  copilotSettings: CopilotSettingsStore
  /** The Qualification questions of every Organization, in the order the Agent asks them. */
  questions: QualificationQuestionStore
  /** The turns of Inbound Agent conversations, with the sources each Agent turn cites. */
  turns: AgentTurnStore
  /** The warm Handoffs of Agent Calls to Reps. */
  handoffs: HandoffStore
  /** Waits `ms`; the Handoff ring polls with it, and a test replaces it to answer mid-ring. */
  sleep: (ms: number) => Promise<void>
  /** What Prospects answered to the Qualification questions, and the summary of it. */
  qualification: QualificationStore
  /** Free times and Bookings of an Organization, held by core. */
  booking: BookingGateway
  /** Finds an Organization's own Documents and Moments for the Agent to answer from. */
  evidence: EvidenceSearch
  /** The language model the Agent writes its replies with. */
  llm: LlmPort
  /** The stored answers of requests sent with an `Idempotency-Key`, per Organization and user. */
  idempotency: IdempotencyStore
  /** Buys, ports and releases numbers at the telephony provider. */
  numbers: NumberProvisioner
  /** How long a call to `numbers` may take before the service gives up on it, in milliseconds. */
  numberTimeoutMs: number
  /** The telephony provider: mints softphone tokens and verifies its webhooks. */
  telephony: TelephonyPort
  /** The Call event log, where provider callbacks are recorded once each. */
  callEvents: CallEventStore
  /** Placed Calls, their state and their log; the only way a module reaches `voice.calls`. */
  calls: CallStore
  /** Each Call's Recording row: where its copy is and when its file may be removed. */
  recordings: RecordingStore
  /** Region object storage, where Recording files are kept. */
  storage: ObjectStore
  /** The events queue other services consume; `voice.call.ended` goes out on it. */
  events: Queue<EventEnvelope>
  /** Our own jobs queue: finishing a Call's Recording and its event. */
  jobs: Queue<JobEnvelope>
  /** The final Transcript turns of Copilot Calls, saved once each. */
  callTurns: CallTurnStore
  /** The retrieval cards shown to Reps during Copilot Calls. */
  copilotCards: CopilotCardStore
  /** Speech-to-text streams: AssemblyAI, an in-memory stand-in locally, or one that fails closed. */
  transcribe: StreamingTranscribePort
  /** The open Copilot streams of this process and the Calls whose Transcript went quiet. */
  copilot: CopilotRuntime
  /** Teams and Reps of an Organization, held by the core service. */
  directory: OrganizationDirectory
  /** Clears expired Twilio rows; set only when the Postgres TwilioStore is in use (`twilio`). */
  twilioPurge?: TwilioPurgeSource
  /**
   * The voice and the audio leg an Agent speaks through. Unset until a speech engine and the media
   * stream are wired (phase 2): a dialed Agent Call then hangs up after its Disclosure.
   */
  agentAudio?: AgentAudio
  /** Releases the database connections; safe to call more than once. */
  close: () => Promise<void>
  /** Probes run by `/readyz`: the database. */
  readinessChecks: readonly ReadinessCheck[]
  /**
   * The one place unexpected errors go. It logs through the kit logger today; the error tracker is
   * wired in here and nowhere else. It must not throw and must not return anything to a client.
   */
  reportError: (error: unknown, context: ErrorContext) => void
  /**
   * Set once shutdown begins: `/readyz` answers 503 from then on, before the server stops.
   * `drainingSince` is when the first signal arrived (epoch ms from `clock`), for shutdown only.
   */
  lifecycle: { draining: boolean; drainingSince?: number }
}

/**
 * Calls `reportError` so that it can neither throw nor leave a rejected promise behind, even if
 * an implementation wrongly went async.
 */
export function reportSafely(container: Container, error: unknown, context: ErrorContext): void {
  try {
    const result: unknown = container.reportError(error, context)
    if (result instanceof Promise) {
      result.catch(() => {})
    }
  } catch {
    // A failing reporter must never turn a handled error into a dropped response.
  }
}

/**
 * Picks the telephony adapter. Twilio runs on the kit adapter over the Postgres `TwilioStore`, so
 * it works in every environment. The in-memory store is not used here: it is refused outside
 * `local` and `dev`, and a durable one keeps calls across instances and restarts.
 */
function createTelephony(env: Env, database: Database): TelephonyPort {
  if (env.TELEPHONY_PROVIDER === 'memory') {
    return createMemoryTelephony()
  }
  const {
    TWILIO_ACCOUNT_SID: accountSid,
    TWILIO_API_KEY_SID: apiKeySid,
    TWILIO_API_KEY_SECRET: apiKeySecret,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_TWIML_APP_SID: twimlAppSid,
    WEBHOOK_BASE_URL: baseUrl,
  } = env
  // The env schema refuses `twilio` without these, so this only narrows the types.
  if (!(accountSid && apiKeySid && apiKeySecret && authToken && twimlAppSid && baseUrl)) {
    throw new TypeError('TELEPHONY_PROVIDER=twilio needs its TWILIO_* keys and WEBHOOK_BASE_URL')
  }
  const callbacks = `${baseUrl}/webhooks/twilio`
  return createTwilioTelephony({
    accountSid,
    apiKeySid,
    apiKeySecret,
    authToken,
    twimlAppSid,
    ...(env.TWILIO_REGION ? { region: env.TWILIO_REGION } : {}),
    environment: env.ENVIRONMENT,
    statusCallbackUrl: `${callbacks}/status`,
    detectionCallbackUrl: `${callbacks}/detection`,
    recordingStatusCallbackUrl: `${callbacks}/recording`,
    store: createPostgresTwilioStore(database),
  })
}

/** Picks the number provisioner: in memory for `memory`, else Twilio over the same API key. */
function createNumbers(env: Env): NumberProvisioner {
  if (env.TELEPHONY_PROVIDER === 'memory') {
    return createRunningMemoryNumberProvisioner()
  }
  const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_API_KEY_SID: apiKeySid } = env
  const { TWILIO_API_KEY_SECRET: apiKeySecret, WEBHOOK_BASE_URL: webhookBaseUrl } = env
  // The env schema refuses `twilio` without these, so this only narrows the types.
  if (!(accountSid && apiKeySid && apiKeySecret && webhookBaseUrl)) {
    throw new TypeError('TELEPHONY_PROVIDER=twilio needs its TWILIO_* keys and WEBHOOK_BASE_URL')
  }
  return createTwilioNumberProvisioner({ accountSid, apiKeySid, apiKeySecret, webhookBaseUrl })
}

/** The Bedrock model adapter, in the Region the service runs in. */
/** AssemblyAI when keyed, an in-memory stand-in locally, otherwise one that fails closed. */
function createTranscribe(env: Env): StreamingTranscribePort {
  if (env.ASSEMBLYAI_API_KEY) {
    return createAssemblyAiStreamingTranscribe({ apiKey: env.ASSEMBLYAI_API_KEY })
  }
  return env.ENVIRONMENT === 'local'
    ? createMemoryStreamingTranscribe()
    : createUnconfiguredStreamingTranscribe()
}

/** Voice needs no strong model: both tiers are `LLM_MODEL`, Haiku 5.5 when unset. */
export function voiceLlmModels(env: Pick<Env, 'LLM_MODEL'>) {
  const model = env.LLM_MODEL ?? DEFAULT_BEDROCK_FAST_MODEL
  return { fast: model, smart: model }
}

function createLlm(env: Env, logger: Logger): LlmPort {
  return createBedrockLlm({ region: env.AWS_REGION, logger, models: voiceLlmModels(env) })
}

/** Picks the directory: core over HTTP when configured, in memory only for an unconfigured local run. */
function createDirectory(env: Env): OrganizationDirectory {
  if (env.CORE_INTERNAL_URL && env.CORE_INTERNAL_TOKEN) {
    return createCoreHttpOrganizationDirectory({
      baseUrl: env.CORE_INTERNAL_URL,
      token: env.CORE_INTERNAL_TOKEN,
    })
  }
  // The env schema requires both keys outside `local`, so only a local run gets here.
  return env.ENVIRONMENT === 'local'
    ? createMemoryOrganizationDirectory()
    : createUnconfiguredOrganizationDirectory()
}

/**
 * Picks the booking gateway: core's public booking routes when a link token map is set, in memory
 * for an unconfigured local run, and otherwise one that fails closed. Core has no route for a
 * Prospect's contact yet, so outside `local` a booking over HTTP fails (shortcut: add the contact
 * lookup when core serves it).
 */
function createBooking(env: Env): BookingGateway {
  const tokens = env.BOOKING_LINK_TOKENS
  if (env.CORE_INTERNAL_URL && tokens) {
    return createCoreHttpBookingGateway({
      baseUrl: env.CORE_INTERNAL_URL,
      linkTokenOf: (organizationId) => tokens[organizationId],
      contactOf: async () =>
        env.ENVIRONMENT === 'local'
          ? { name: 'Local Prospect', email: 'prospect@example.test', timeZone: 'UTC' }
          : undefined,
    })
  }
  return env.ENVIRONMENT === 'local'
    ? createMemoryBookingGateway()
    : createUnconfiguredBookingGateway()
}

/**
 * Picks the Contact Check: core over HTTP when it is configured, in memory (denying everything not
 * preset) for an unconfigured local run, and otherwise one that denies with `consent.unavailable`.
 */
function createContactGuard(env: Env, logger: Logger): ContactGuard {
  if (env.CORE_INTERNAL_URL && env.CORE_INTERNAL_TOKEN) {
    return createHttpContactGuard({
      baseUrl: env.CORE_INTERNAL_URL,
      secret: env.CORE_INTERNAL_TOKEN,
      environment: env.ENVIRONMENT,
      caller: 'voice',
      logger,
    })
  }
  return env.ENVIRONMENT === 'local' ? createMemoryContactGuard() : createUnconfiguredContactGuard()
}

/** Picks evidence search: the Playbook over HTTP when configured, in memory only for an unconfigured local run. */
function createEvidenceSearch(env: Env): EvidenceSearch {
  if (env.PLAYBOOK_INTERNAL_URL && env.PLAYBOOK_INTERNAL_TOKEN) {
    return createPlaybookHttpEvidenceSearch({
      baseUrl: env.PLAYBOOK_INTERNAL_URL,
      token: env.PLAYBOOK_INTERNAL_TOKEN,
    })
  }
  // The env schema requires both keys outside `local`, so only a local run gets here.
  return env.ENVIRONMENT === 'local'
    ? createMemoryEvidenceSearch()
    : createUnconfiguredEvidenceSearch()
}

/** Picks a queue: SQS when its URL is set, in memory only for an unconfigured local run. */
function createQueue<const D extends AnyDefinition>(
  env: Env,
  queueUrl: string | undefined,
  registry: MessageRegistry<D>
): Queue<EnvelopeOf<D>> {
  if (queueUrl) {
    return createSqsQueue({
      queueUrl,
      region: env.AWS_REGION,
      environment: env.ENVIRONMENT,
      registry,
      ...(env.QUEUE_ENDPOINT === undefined ? {} : { endpoint: env.QUEUE_ENDPOINT }),
    })
  }
  // The env schema requires the URLs outside `local`, so only a local run gets here.
  return createMemoryQueue({ registry, clock: systemClock })
}

/** Picks object storage: S3 when a bucket is set, in memory only for an unconfigured local run. */
function createStorage(env: Env): ObjectStore {
  if (env.STORAGE_BUCKET) {
    return createS3ObjectStore({
      bucket: env.STORAGE_BUCKET,
      region: env.AWS_REGION,
      environment: env.ENVIRONMENT,
      ...(env.STORAGE_ENDPOINT === undefined ? {} : { endpoint: env.STORAGE_ENDPOINT }),
    })
  }
  return createMemoryObjectStore()
}

/** Options for {@link createContainer}. */
export type ContainerOptions = {
  /** Where log lines go; defaults to stdout. */
  logDestination?: LogDestination
}

/** The single composition root: the only place adapters and process-wide objects are constructed. */
export function createContainer(env: Env = loadEnv(), options: ContainerOptions = {}): Container {
  const logger = createLogger({
    service: SERVICE,
    level: env.LOG_LEVEL,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  })

  const database = createDb(env.DATABASE_URL)
  const keys = createRemoteKeySet({
    url: env.AUTH_JWKS_URL,
    allowInsecureLocalhost: env.ENVIRONMENT === 'local',
    clock: systemClock,
    logger,
  })

  const jobs = createQueue(env, env.JOBS_QUEUE_URL, jobRegistry)

  return {
    env,
    logger,
    clock: systemClock,
    tokenVerifier: createTokenVerifier({
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      keys,
      clock: systemClock,
    }),
    lines: createPostgresLineStore(database.db),
    agentCalls: createPostgresAgentCallStore(database.db),
    // Core has no internal route for a Prospect's number yet: only a local run gets a directory.
    prospects:
      env.ENVIRONMENT === 'local'
        ? createMemoryProspectDirectory()
        : createUnconfiguredProspectDirectory(),
    contactGuard: createContactGuard(env, logger),
    agentSettings: createPostgresAgentSettingsStore(database.db),
    copilotSettings: createPostgresCopilotSettingsStore(database.db),
    questions: createPostgresQualificationQuestionStore(database.db),
    turns: createPostgresAgentTurnStore(database.db),
    handoffs: createPostgresHandoffStore(database.db),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    qualification: createPostgresQualificationStore(database.db),
    booking: createBooking(env),
    // The Playbook's internal search route; only a local run without PLAYBOOK_INTERNAL_* gets the
    // (empty) in-memory search.
    evidence: createEvidenceSearch(env),
    llm: createLlm(env, logger),
    idempotency: createPostgresIdempotencyStore(database.db),
    // The in-memory provisioner is local-only (the env schema rejects it elsewhere); a deployment
    // on `twilio` buys, ports and releases at Twilio.
    numbers: createNumbers(env),
    numberTimeoutMs: NUMBER_PROVISIONER_TIMEOUT_MS,
    telephony: createTelephony(env, database.db),
    callEvents: createPostgresCallEventStore(database.db),
    // Every Call that reaches a final state queues its finishing job (see publishOnFinal).
    calls: publishOnFinal(createPostgresCallStore(database.db), jobs, logger),
    recordings: createPostgresRecordingStore(database.db),
    storage: createStorage(env),
    events: createQueue(env, env.QUEUE_URL, eventRegistry),
    jobs,
    callTurns: createPostgresCallTurnStore(database.db),
    copilotCards: createPostgresCopilotCardStore(database.db),
    transcribe: createTranscribe(env),
    copilot: createCopilotRuntime(),
    // Teams and Reps live in core's schema, which this service never reads: ask core over HTTP.
    // Only a local run without CORE_INTERNAL_* gets the in-memory directory (empty).
    directory: createDirectory(env),
    ...(env.TELEPHONY_PROVIDER === 'twilio'
      ? {
          twilioPurge: createPostgresTwilioPurgeSource(
            database.db,
            env.TWILIO_PURGE_QUERY_TIMEOUT_MS
          ),
        }
      : {}),
    close: database.close,
    readinessChecks: [
      {
        name: 'database',
        run: async () => {
          await database.db.execute(sql`select 1`)
        },
      },
    ],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      logger.error('unhandled error', { ...context, error: describeError(error) })
    },
  }
}
