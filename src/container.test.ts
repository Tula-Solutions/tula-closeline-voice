import { expect, test } from 'bun:test'
import { signTwilioRequest } from 'tula-closeline-kit'
import { createContainer, reportSafely } from './container'
import { loadEnv } from './env'

test('the default reportError logs the failure with its request context at error level', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'a'.repeat(32)}` as never

  container.reportError(new Error('disk on fire'), {
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
  })

  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    level: 50, // error
    msg: 'unhandled error',
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
    error: { name: 'Error', message: 'disk on fire' },
  })
})

test('the default reportError logs the stack frames and the whole cause chain', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'c'.repeat(32)}` as never
  const error = new Error('query failed', { cause: new TypeError('socket closed') })

  container.reportError(error, { requestId, method: 'GET', path: '/x', status: 500 })

  const logged = JSON.parse(lines[0] ?? '{}')
  expect(logged.error.stack.length).toBeGreaterThan(0)
  expect(logged.error.cause).toMatchObject({ name: 'TypeError', message: 'socket closed' })
})

test('the default reportError bounds a long message', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'d'.repeat(32)}` as never

  container.reportError(new Error('z'.repeat(50_000)), {
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
  })

  expect((lines[0] ?? '').length).toBeLessThan(5_000)
})

test('reportSafely swallows a reporter that throws or rejects', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', listener)
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))
  const context = {
    requestId: `req_${'e'.repeat(32)}` as never,
    method: 'GET',
    path: '/x',
    status: 500,
  }

  try {
    container.reportError = () => {
      throw new Error('sync failure')
    }
    reportSafely(container, new Error('a'), context)
    container.reportError = (async () => {
      throw new Error('async failure')
    }) as never
    reportSafely(container, new Error('b'), context)
    await Bun.sleep(20)

    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('the default reportError records a thrown non-Error without its value', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'b'.repeat(32)}` as never

  container.reportError('password=hunter2', { requestId, method: 'GET', path: '/x', status: 500 })

  expect(lines[0]).not.toContain('hunter2')
})

test('LOG_LEVEL silences the logger', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }), {
    logDestination: { write: (l) => lines.push(l) },
  })

  container.logger.error('nothing to see')

  expect(lines).toHaveLength(0)
})

test('a container built from the environment checks the database for readiness', () => {
  const checks = createContainer(loadEnv({ ENVIRONMENT: 'local' })).readinessChecks
  expect(checks.map((check) => check.name)).toEqual(['database'])
})

const DEPLOYED_SOURCE = {
  REGION: 'us',
  DATABASE_URL: 'postgres://closeline_voice:secret@db.internal:5432/closeline',
  AUTH_JWKS_URL: 'https://auth.example/.well-known/jwks.json',
  AUTH_ISSUER: 'https://auth.example',
  AUTH_AUDIENCE: 'closeline',
  AWS_REGION: 'us-east-1',
  QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/voice-events',
  STORAGE_BUCKET: 'closeline-voice-recordings',
}

const TWILIO_LOCAL = {
  ENVIRONMENT: 'local',
  TELEPHONY_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'api-key-secret-0123456789',
  TWILIO_AUTH_TOKEN: 'auth-token-0123456789abcdef',
  TWILIO_TWIML_APP_SID: `AP${'c'.repeat(32)}`,
  WEBHOOK_BASE_URL: 'http://voice.test',
}

test('twilio in local verifies the signatures Twilio makes with the auth token', () => {
  const container = createContainer(loadEnv(TWILIO_LOCAL), { logDestination: { write: () => {} } })
  const url = 'http://voice.test/webhooks/twilio/status?callId=x'
  const params = { CallSid: 'CA1', CallStatus: 'completed' }
  const signature = signTwilioRequest(TWILIO_LOCAL.TWILIO_AUTH_TOKEN, url, params)
  const body = new URLSearchParams(params).toString()

  expect(container.telephony.verifyWebhook({ url, body, signature })).toBe(true)
  expect(container.telephony.verifyWebhook({ url, body, signature: 'forged' })).toBe(false)
})

test('twilio in a deployed environment fails closed until it has a durable store', async () => {
  const lines: string[] = []
  const container = createContainer(
    loadEnv({
      ...TWILIO_LOCAL,
      ENVIRONMENT: 'prod',
      ...DEPLOYED_SOURCE,
      WEBHOOK_BASE_URL: 'https://voice.test',
    }),
    { logDestination: { write: (l) => lines.push(l) } }
  )
  const url = 'https://voice.test/webhooks/twilio/status'
  const signature = signTwilioRequest(TWILIO_LOCAL.TWILIO_AUTH_TOKEN, url, {})

  expect(container.telephony.verifyWebhook({ url, body: '', signature })).toBe(false)
  await expect(
    container.telephony.mintBrowserToken({
      organizationId: `org_${'a'.repeat(32)}` as never,
      identity: `mem_${'a'.repeat(32)}` as never,
    })
  ).rejects.toMatchObject({ code: 'server.unavailable' })
  expect(lines.join('\n')).toContain('telephony is not available')
})
