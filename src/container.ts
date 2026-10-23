import { sql } from 'drizzle-orm'
import type { RequestId } from 'tula-closeline-contract'
import { createDb, type Database } from 'tula-closeline-db'
import {
  type Clock,
  createLogger,
  createRemoteKeySet,
  createTokenVerifier,
  createTwilioTelephony,
  type LogDestination,
  type Logger,
  systemClock,
  type TelephonyPort,
  type TokenVerifier,
} from 'tula-closeline-kit'
import { createMemoryTelephony } from 'tula-closeline-kit/testing'
import { createCoreHttpOrganizationDirectory } from '~/adapters/core-http/organization-directory'
import { createRunningMemoryNumberProvisioner } from '~/adapters/memory/number-provisioner'
import { createMemoryOrganizationDirectory } from '~/adapters/memory/organization-directory'
import { createPostgresCallEventStore } from '~/adapters/postgres/call-event-store'
import { createPostgresIdempotencyStore } from '~/adapters/postgres/idempotency-store'
import { createPostgresLineStore } from '~/adapters/postgres/line-store'
import { createPostgresTwilioPurgeSource } from '~/adapters/postgres/twilio-purge-source'
import { createPostgresTwilioStore } from '~/adapters/postgres/twilio-store'
import {
  createUnconfiguredNumberProvisioner,
  createUnconfiguredOrganizationDirectory,
} from '~/adapters/unconfigured'
import { describeError } from '~/describe-error'
import { type Env, loadEnv } from '~/env'
import { SERVICE } from '~/info'
import type { CallEventStore } from '~/ports/call-event-store'
import type { IdempotencyStore } from '~/ports/idempotency-store'
import type { LineStore } from '~/ports/line-store'
import { NUMBER_PROVISIONER_TIMEOUT_MS, type NumberProvisioner } from '~/ports/number-provisioner'
import type { OrganizationDirectory } from '~/ports/organization-directory'
import type { TwilioPurgeSource } from '~/ports/twilio-purge-source'

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
  /** Teams and Reps of an Organization, held by the core service. */
  directory: OrganizationDirectory
  /** Clears expired Twilio rows; set only when the Postgres TwilioStore is in use (`twilio`). */
  twilioPurge?: TwilioPurgeSource
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
    recordingStatusCallbackUrl: `${callbacks}/recording`,
    store: createPostgresTwilioStore(database),
  })
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
    idempotency: createPostgresIdempotencyStore(database.db),
    // The in-memory provisioner is local-only (the env schema rejects it elsewhere); a deployment
    // on `twilio` has no number adapter yet, so buying, porting and releasing fail closed.
    numbers:
      env.TELEPHONY_PROVIDER === 'memory'
        ? createRunningMemoryNumberProvisioner()
        : createUnconfiguredNumberProvisioner(),
    numberTimeoutMs: NUMBER_PROVISIONER_TIMEOUT_MS,
    telephony: createTelephony(env, database.db),
    callEvents: createPostgresCallEventStore(database.db),
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
