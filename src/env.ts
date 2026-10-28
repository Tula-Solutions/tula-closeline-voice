import { regionSchema } from 'tula-closeline-contract'
import { TWILIO_REGIONS } from 'tula-closeline-kit'
import { z } from 'zod'

/** The most grace plus drain may add up to, so an orchestrator's kill window is not outlasted. */
const MAX_SHUTDOWN_TOTAL_MS = 60_000

/** The Region, database login, token issuer and AWS Region a `local` run falls back to. */
const LOCAL_DEFAULTS = {
  REGION: 'us',
  DATABASE_URL: 'postgres://closeline_voice:closeline_voice_local@127.0.0.1:5432/closeline',
  AUTH_JWKS_URL: 'http://127.0.0.1:3001/.well-known/jwks.json',
  AUTH_ISSUER: 'http://127.0.0.1:3001',
  AUTH_AUDIENCE: 'closeline',
  AWS_REGION: 'us-east-1',
  TELEPHONY_PROVIDER: 'memory',
} as const

/** The vendor prices a `local` run falls back to, in micro-cents (one millionth of a cent). */
const LOCAL_PRICES = {
  STT_PRICE_MICRO_CENTS_PER_SECOND: 4_000,
  TTS_PRICE_MICRO_CENTS_PER_CHARACTER: 1_500,
  LLM_INPUT_PRICE_MICRO_CENTS_PER_TOKEN: 30,
  LLM_OUTPUT_PRICE_MICRO_CENTS_PER_TOKEN: 150,
} as const

/** The price keys: each a non-negative whole number of micro-cents per unit. */
const PRICE_KEYS = Object.keys(LOCAL_PRICES) as (keyof typeof LOCAL_PRICES)[]

/** The internal secret a local run accepts when none is set (ADR 0013); refused everywhere else. */
export const LOCAL_INTERNAL_API_TOKEN = 'local-voice-internal-secret-not-for-deploys'

/** Bounds of the internal secrets: two is a rotation, more is a mistake. */
const MAX_INTERNAL_TOKENS = 5
const MIN_INTERNAL_TOKEN_LENGTH = 32
const MAX_INTERNAL_TOKEN_LENGTH = 512

/** A secret is printable ASCII with no space, so it travels in a bearer header unchanged. */
const PRINTABLE_ASCII = /^[!-~]+$/

/** The keys that must be set in every environment but `local`, where they have defaults. */
const REQUIRED_OUTSIDE_LOCAL = [
  'REGION',
  'DATABASE_URL',
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'AWS_REGION',
  'QUEUE_URL',
  'STORAGE_BUCKET',
  'TELEPHONY_PROVIDER',
  'CORE_INTERNAL_URL',
  'CORE_INTERNAL_TOKEN',
  'PLAYBOOK_INTERNAL_URL',
  'PLAYBOOK_INTERNAL_TOKEN',
  'INTERNAL_API_TOKENS',
  ...PRICE_KEYS,
] as const

/** The Twilio keys a `twilio` provider cannot run without. */
const TWILIO_REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_TWIML_APP_SID',
  'WEBHOOK_BASE_URL',
] as const

/** A price per unit: a non-negative whole number of micro-cents, bounded to catch a unit mistake. */
const priceSchema = z.coerce.number().int().min(0).max(1_000_000_000)

const schema = z
  .object({
    /** Which deployment this is. No default: a deploy that forgets it must fail at boot. */
    ENVIRONMENT: z.enum(['local', 'dev', 'staging', 'prod']),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    /** The longest one readiness check may take before it counts as failed. */
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
    /** The longest shutdown waits for in-flight requests before closing them. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
    /** How long `/readyz` reports 503 before the server stops accepting, so the balancer moves on. */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    /** The largest request body accepted, in bytes; anything bigger is a 413. */
    MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1).max(104_857_600).default(1_048_576),
    /** The Region this deployment serves; every Organization it holds lives in it. */
    REGION: regionSchema.optional(),
    /** Postgres connection string of the `closeline_voice` login. It carries a password: never log it. */
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string')
      .optional(),
    /** Where the auth service publishes its signing keys (https; http only when local). */
    AUTH_JWKS_URL: z.url().optional(),
    /** The `iss` every access token must carry. */
    AUTH_ISSUER: z.string().min(1).max(2_048).optional(),
    /** The `aud` every access token must carry. */
    AUTH_AUDIENCE: z.string().min(1).max(2_048).optional(),
    /** The AWS Region of the queue and the bucket (not the Closeline Region above). */
    AWS_REGION: z.string().min(1).max(64).optional(),
    /** The event queue's URL. Required outside `local`. */
    QUEUE_URL: z.url().max(2_048).optional(),
    /** Where ElasticMQ listens, for a local run against it. Accepted only when `local`. */
    QUEUE_ENDPOINT: z.url().max(2_048).optional(),
    /** The bucket holding Call recordings. Required outside `local`. */
    STORAGE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'STORAGE_BUCKET must be a valid bucket name')
      .optional(),
    /** Where S3Mock listens, for a local run against it. Accepted only when `local`. */
    STORAGE_ENDPOINT: z.url().max(2_048).optional(),
    /**
     * The telephony provider. `memory` is the in-process stand-in and is accepted only when
     * `local`; `twilio` is the real one and needs the TWILIO_* keys and WEBHOOK_BASE_URL.
     */
    TELEPHONY_PROVIDER: z.enum(['memory', 'twilio']).optional(),
    /** Twilio Account SID. Required when `TELEPHONY_PROVIDER=twilio`. */
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(/^AC[0-9a-f]{32}$/, 'TWILIO_ACCOUNT_SID must be AC and 32 hex digits')
      .optional(),
    /** SID of the Twilio API key that signs requests and Softphone tokens. */
    TWILIO_API_KEY_SID: z
      .string()
      .regex(/^SK[0-9a-f]{32}$/, 'TWILIO_API_KEY_SID must be SK and 32 hex digits')
      .optional(),
    /** Secret of that API key. A credential: never log it. */
    TWILIO_API_KEY_SECRET: z.string().min(16).max(256).optional(),
    /** The Auth Token, used only to verify webhook signatures. A credential: never log it. */
    TWILIO_AUTH_TOKEN: z.string().min(16).max(256).optional(),
    /** SID of the TwiML App the Softphone dials out through. */
    TWILIO_TWIML_APP_SID: z
      .string()
      .regex(/^AP[0-9a-f]{32}$/, 'TWILIO_TWIML_APP_SID must be AP and 32 hex digits')
      .optional(),
    /**
     * Core's origin for the internal directory lookups (Memberships, Reps, Teams). https outside
     * `local`. Required outside `local`; when `local` and unset, an in-memory directory is used.
     */
    CORE_INTERNAL_URL: z.url().max(2_048).optional(),
    /**
     * The bearer secret core lists in its INTERNAL_API_TOKENS. A credential: never log it.
     * Required with `CORE_INTERNAL_URL`.
     */
    CORE_INTERNAL_TOKEN: z.string().min(16).max(512).optional(),
    /**
     * JSON map of Organization id to the token of its Booking Type link in core, so the Agent can
     * read free times and book through core's public routes. A credential: never log it.
     * shortcut: an env map until Agent settings carry the link; unset means no booking over HTTP.
     */
    BOOKING_LINK_TOKENS: z
      .string()
      .max(8_192)
      .transform((raw, context) => {
        try {
          return z.record(z.string().min(1), z.string().min(8).max(256)).parse(JSON.parse(raw))
        } catch {
          context.addIssue({ code: 'custom', message: 'BOOKING_LINK_TOKENS must be a JSON map' })
          return z.NEVER
        }
      })
      .optional(),
    /**
     * The Playbook's origin for the internal Document search the Agent answers from. https outside
     * `local`. Required outside `local`; when `local` and unset, an empty in-memory search is used.
     */
    PLAYBOOK_INTERNAL_URL: z.url().max(2_048).optional(),
    /**
     * The internal bearer secret the Playbook accepts (ADR 0013). A credential: never log it.
     * Required with `PLAYBOOK_INTERNAL_URL`.
     */
    PLAYBOOK_INTERNAL_TOKEN: z.string().min(16).max(512).optional(),
    /**
     * The bearer secrets callers of `/internal/v1/*` may present, comma separated (ADR 0013); more
     * than one lets a secret be rotated without downtime. Each is 32 to 512 printable characters.
     * Required outside `local`, where the public local default is used when unset. Credentials:
     * never log them.
     */
    INTERNAL_API_TOKENS: z
      .string()
      .max(MAX_INTERNAL_TOKENS * (MAX_INTERNAL_TOKEN_LENGTH + 1))
      .optional(),
    /** The Twilio region of the account's API keys; omit for the US default. */
    TWILIO_REGION: z.enum(TWILIO_REGIONS).optional(),
    /**
     * The public https origin Twilio reaches this service on (no path), for the status callbacks the
     * adapter registers and for rebuilding the URL a webhook signature covers. Required when
     * `TELEPHONY_PROVIDER=twilio`; `http` is accepted only when `local`.
     */
    WEBHOOK_BASE_URL: z.url().max(2_048).optional(),
    /**
     * How often, on average, each instance purges expired Twilio rows (jittered by 20% either way).
     * It runs only when `TELEPHONY_PROVIDER=twilio`, the one case that stores them in Postgres.
     */
    TWILIO_PURGE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(900_000),
    /** The most Organizations one purge run visits; the next run takes the rest. */
    TWILIO_PURGE_MAX_ORGANIZATIONS: z.coerce.number().int().min(1).max(10_000).default(200),
    /** Longest one purge-source query (a scan page or an Organization's purge) may run, in ms. */
    TWILIO_PURGE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
    /** How often, on average, each instance sweeps for inbound Calls that rang out (jittered 20%). */
    MISSED_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(5_000),
    /** The most Organizations one missed-Call sweep visits; the next run takes the rest. */
    MISSED_SWEEP_MAX_ORGANIZATIONS: z.coerce.number().int().min(1).max(10_000).default(200),
    /** Vendor price of speech-to-text per second of audio, in micro-cents. Required outside `local`. */
    STT_PRICE_MICRO_CENTS_PER_SECOND: priceSchema.optional(),
    /** Vendor price of text-to-speech per character spoken, in micro-cents. Required outside `local`. */
    TTS_PRICE_MICRO_CENTS_PER_CHARACTER: priceSchema.optional(),
    /** Vendor price of one model input token, in micro-cents. Required outside `local`. */
    LLM_INPUT_PRICE_MICRO_CENTS_PER_TOKEN: priceSchema.optional(),
    /** Vendor price of one model output token, in micro-cents. Required outside `local`. */
    LLM_OUTPUT_PRICE_MICRO_CENTS_PER_TOKEN: priceSchema.optional(),
    /** How long an inbound Call rings the Reps before it is recorded `missed`, in ms. */
    RING_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  })
  .refine((env) => env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS <= MAX_SHUTDOWN_TOTAL_MS, {
    message: `SHUTDOWN_GRACE_MS plus SHUTDOWN_TIMEOUT_MS must not exceed ${MAX_SHUTDOWN_TOTAL_MS} ms in total`,
    path: ['SHUTDOWN_TIMEOUT_MS'],
  })
  .superRefine((env, context) => {
    // Messages name the key and the rule, never the value: a URL can carry credentials.
    if (env.ENVIRONMENT !== 'local') {
      for (const key of REQUIRED_OUTSIDE_LOCAL) {
        if (env[key] === undefined) {
          context.addIssue({ code: 'custom', path: [key], message: `${key} is required` })
        }
      }
      if (env.TELEPHONY_PROVIDER === 'memory') {
        context.addIssue({
          code: 'custom',
          path: ['TELEPHONY_PROVIDER'],
          message: 'TELEPHONY_PROVIDER memory is accepted only when ENVIRONMENT is local',
        })
      }
    }
    if (env.INTERNAL_API_TOKENS !== undefined) {
      const entries = env.INTERNAL_API_TOKENS.split(',')
      // Messages name the position, never the secret.
      if (entries.length > MAX_INTERNAL_TOKENS) {
        context.addIssue({
          code: 'custom',
          path: ['INTERNAL_API_TOKENS'],
          message: `at most ${MAX_INTERNAL_TOKENS} secrets`,
        })
      }
      entries.forEach((entry, index) => {
        if (
          entry.length < MIN_INTERNAL_TOKEN_LENGTH ||
          entry.length > MAX_INTERNAL_TOKEN_LENGTH ||
          !PRINTABLE_ASCII.test(entry)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['INTERNAL_API_TOKENS'],
            message: `secret ${index + 1} must be ${MIN_INTERNAL_TOKEN_LENGTH} to ${MAX_INTERNAL_TOKEN_LENGTH} characters, with no empty entry or spaces`,
          })
        }
        if (env.ENVIRONMENT !== 'local' && entry === LOCAL_INTERNAL_API_TOKEN) {
          context.addIssue({
            code: 'custom',
            path: ['INTERNAL_API_TOKENS'],
            message: `secret ${index + 1} is the public local default, accepted only when ENVIRONMENT is local`,
          })
        }
      })
    }
    if ((env.CORE_INTERNAL_URL === undefined) !== (env.CORE_INTERNAL_TOKEN === undefined)) {
      const missing =
        env.CORE_INTERNAL_URL === undefined ? 'CORE_INTERNAL_URL' : 'CORE_INTERNAL_TOKEN'
      context.addIssue({
        code: 'custom',
        path: [missing],
        message: 'CORE_INTERNAL_URL and CORE_INTERNAL_TOKEN are set together',
      })
    }
    if (env.CORE_INTERNAL_URL !== undefined) {
      const core = new URL(env.CORE_INTERNAL_URL)
      if (
        core.protocol !== 'https:' &&
        !(env.ENVIRONMENT === 'local' && core.protocol === 'http:')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['CORE_INTERNAL_URL'],
          message: 'CORE_INTERNAL_URL must be https (http only when ENVIRONMENT is local)',
        })
      }
    }
    if ((env.PLAYBOOK_INTERNAL_URL === undefined) !== (env.PLAYBOOK_INTERNAL_TOKEN === undefined)) {
      const missing =
        env.PLAYBOOK_INTERNAL_URL === undefined
          ? 'PLAYBOOK_INTERNAL_URL'
          : 'PLAYBOOK_INTERNAL_TOKEN'
      context.addIssue({
        code: 'custom',
        path: [missing],
        message: 'PLAYBOOK_INTERNAL_URL and PLAYBOOK_INTERNAL_TOKEN are set together',
      })
    }
    if (env.PLAYBOOK_INTERNAL_URL !== undefined) {
      const playbook = new URL(env.PLAYBOOK_INTERNAL_URL)
      if (
        playbook.protocol !== 'https:' &&
        !(env.ENVIRONMENT === 'local' && playbook.protocol === 'http:')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['PLAYBOOK_INTERNAL_URL'],
          message: 'PLAYBOOK_INTERNAL_URL must be https (http only when ENVIRONMENT is local)',
        })
      }
    }
    if (env.TELEPHONY_PROVIDER === 'twilio') {
      for (const key of TWILIO_REQUIRED) {
        if (env[key] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when TELEPHONY_PROVIDER is twilio`,
          })
        }
      }
    }
    if (env.WEBHOOK_BASE_URL !== undefined) {
      const base = new URL(env.WEBHOOK_BASE_URL)
      const insecureOk = env.ENVIRONMENT === 'local'
      if (base.protocol !== 'https:' && !(insecureOk && base.protocol === 'http:')) {
        context.addIssue({
          code: 'custom',
          path: ['WEBHOOK_BASE_URL'],
          message: 'WEBHOOK_BASE_URL must be https (http only when ENVIRONMENT is local)',
        })
      }
      if (base.pathname !== '/' || base.search !== '' || base.hash !== '') {
        context.addIssue({
          code: 'custom',
          path: ['WEBHOOK_BASE_URL'],
          message: 'WEBHOOK_BASE_URL must be an origin only, with no path or query',
        })
      }
    }
    for (const [endpoint, owner] of [
      ['QUEUE_ENDPOINT', 'QUEUE_URL'],
      ['STORAGE_ENDPOINT', 'STORAGE_BUCKET'],
    ] as const) {
      if (env[endpoint] === undefined) {
        continue
      }
      if (env.ENVIRONMENT !== 'local') {
        context.addIssue({
          code: 'custom',
          path: [endpoint],
          message: `${endpoint} is accepted only when ENVIRONMENT is local`,
        })
      }
      if (env[owner] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [endpoint],
          message: `${endpoint} needs ${owner}`,
        })
      }
    }
  })
  .transform((env) => {
    // Outside local the superRefine has already rejected a missing key; only a local run falls back.
    const local = env.ENVIRONMENT === 'local'
    const need = <T>(value: T | undefined, fallback: T): T => {
      if (value !== undefined) {
        return value
      }
      if (local) {
        return fallback
      }
      throw new Error('a required key was not checked')
    }
    return {
      ...env,
      REGION: need(env.REGION, LOCAL_DEFAULTS.REGION),
      DATABASE_URL: need(env.DATABASE_URL, LOCAL_DEFAULTS.DATABASE_URL),
      AUTH_JWKS_URL: need(env.AUTH_JWKS_URL, LOCAL_DEFAULTS.AUTH_JWKS_URL),
      AUTH_ISSUER: need(env.AUTH_ISSUER, LOCAL_DEFAULTS.AUTH_ISSUER),
      AUTH_AUDIENCE: need(env.AUTH_AUDIENCE, LOCAL_DEFAULTS.AUTH_AUDIENCE),
      AWS_REGION: need(env.AWS_REGION, LOCAL_DEFAULTS.AWS_REGION),
      TELEPHONY_PROVIDER: need<'memory' | 'twilio'>(
        env.TELEPHONY_PROVIDER,
        LOCAL_DEFAULTS.TELEPHONY_PROVIDER
      ),
      STT_PRICE_MICRO_CENTS_PER_SECOND: need(
        env.STT_PRICE_MICRO_CENTS_PER_SECOND,
        LOCAL_PRICES.STT_PRICE_MICRO_CENTS_PER_SECOND
      ),
      TTS_PRICE_MICRO_CENTS_PER_CHARACTER: need(
        env.TTS_PRICE_MICRO_CENTS_PER_CHARACTER,
        LOCAL_PRICES.TTS_PRICE_MICRO_CENTS_PER_CHARACTER
      ),
      LLM_INPUT_PRICE_MICRO_CENTS_PER_TOKEN: need(
        env.LLM_INPUT_PRICE_MICRO_CENTS_PER_TOKEN,
        LOCAL_PRICES.LLM_INPUT_PRICE_MICRO_CENTS_PER_TOKEN
      ),
      LLM_OUTPUT_PRICE_MICRO_CENTS_PER_TOKEN: need(
        env.LLM_OUTPUT_PRICE_MICRO_CENTS_PER_TOKEN,
        LOCAL_PRICES.LLM_OUTPUT_PRICE_MICRO_CENTS_PER_TOKEN
      ),
      INTERNAL_API_TOKENS: (env.INTERNAL_API_TOKENS?.split(',') ??
        (local ? [LOCAL_INTERNAL_API_TOKEN] : [])) as readonly string[],
    }
  })

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}
