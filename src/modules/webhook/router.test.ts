import { beforeEach, describe, expect, test } from 'bun:test'
import { MAX_WEBHOOK_BODY_BYTES } from 'tula-closeline-kit'
import { createTestApp, newOrganizationId, type TestApp } from '~/testing'
import {
  createStubbedTwilio,
  newCallId,
  type SignedRequest,
  signedRequest,
  TEST_BASE_URL,
} from './twilio-fixture'

let t: TestApp
let organizationId: string
let callId: string

const statusPath = () => `/webhooks/twilio/status?organizationId=${organizationId}&callId=${callId}`
const recordingPath = () =>
  `/webhooks/twilio/recording?organizationId=${organizationId}&callId=${callId}`

const send = (request: SignedRequest) => t.app.request(request.path, request.init)
const status = (callStatus: string, extra: Record<string, string> = {}) =>
  signedRequest(statusPath(), {
    CallSid: `CA${'1'.repeat(32)}`,
    CallStatus: callStatus,
    SequenceNumber: '1',
    Timestamp: 'Thu, 01 Jan 2026 00:00:05 +0000',
    ...extra,
  })

beforeEach(async () => {
  t = await createTestApp({
    env: { WEBHOOK_BASE_URL: TEST_BASE_URL },
    telephony: createStubbedTwilio(),
  })
  organizationId = newOrganizationId()
  callId = newCallId()
  t.deps.callEvents.addCall(organizationId, callId)
})

describe('POST /webhooks/twilio/status', () => {
  test('a signed status callback is recorded once', async () => {
    const response = await send(status('completed'))
    expect(response.status).toBe(200)
    expect(t.deps.callEvents.recorded).toHaveLength(1)
    expect(t.deps.callEvents.recorded[0]).toMatchObject({
      organizationId,
      callId,
      occurredAt: new Date('2026-01-01T00:00:05Z'),
    })
  })

  test('a bad signature answers 403 and records nothing', async () => {
    const response = await send(
      signedRequest(
        statusPath(),
        { CallSid: 'CA1', CallStatus: 'completed' },
        { signature: 'AAAA' }
      )
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'auth.forbidden'
    )
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('a missing signature answers 403 and records nothing', async () => {
    const response = await send(
      signedRequest(statusPath(), { CallSid: 'CA1', CallStatus: 'completed' }, { signature: null })
    )
    expect(response.status).toBe(403)
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('a signature made for another call URL is refused', async () => {
    const forged = signedRequest(statusPath(), { CallSid: 'CA1', CallStatus: 'completed' })
    const other = `/webhooks/twilio/status?organizationId=${newOrganizationId()}&callId=${callId}`
    const response = await t.app.request(other, forged.init)
    expect(response.status).toBe(403)
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('a body that was changed after signing is refused', async () => {
    const request = status('completed')
    const response = await t.app.request(request.path, {
      ...request.init,
      body: request.body.replace('completed', 'failed'),
    })
    expect(response.status).toBe(403)
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('the same event id again answers 200 and changes nothing', async () => {
    const first = await send(status('ringing', { SequenceNumber: '0' }))
    const second = await send(status('ringing', { SequenceNumber: '0' }))
    expect([first.status, second.status]).toEqual([200, 200])
    expect(t.deps.callEvents.recorded).toHaveLength(1)
  })

  test('the unsigned idempotency token header cannot mint a second event', async () => {
    const params = { CallSid: 'CA1', CallStatus: 'ringing', SequenceNumber: '0' }
    await send(signedRequest(statusPath(), params, { token: 'tok-1' }))
    await send(signedRequest(statusPath(), params, { token: 'tok-2' }))
    expect(t.deps.callEvents.recorded).toHaveLength(1)
  })

  test('different statuses of one call are different events', async () => {
    await send(status('ringing', { SequenceNumber: '0' }))
    await send(status('in-progress', { SequenceNumber: '1' }))
    await send(status('completed', { SequenceNumber: '2' }))
    expect(t.deps.callEvents.recorded).toHaveLength(3)
  })

  test('queued and initiated are acknowledged without a record', async () => {
    expect((await send(status('queued'))).status).toBe(200)
    expect((await send(status('initiated'))).status).toBe(200)
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('an unknown status is request.invalid', async () => {
    const response = await send(status('exploded'))
    expect(response.status).toBe(400)
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('a call of another Organization is not recorded against', async () => {
    const other = newOrganizationId()
    const request = signedRequest(
      `/webhooks/twilio/status?organizationId=${other}&callId=${callId}`,
      { CallSid: 'CA1', CallStatus: 'completed', SequenceNumber: '1' }
    )
    const response = await send(request)
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'call.provider_call_not_found'
    )
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('a callback URL without a valid Organization and Call is request.invalid', async () => {
    const request = signedRequest('/webhooks/twilio/status?callId=nope', {
      CallSid: 'CA1',
      CallStatus: 'completed',
    })
    expect((await send(request)).status).toBe(400)
  })

  test('a body over the limit is refused before anything is checked', async () => {
    const response = await t.app.request(statusPath(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `x=${'a'.repeat(MAX_WEBHOOK_BODY_BYTES)}`,
    })
    expect(response.status).toBe(413)
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('nothing about the request body or signature reaches the logs', async () => {
    await send(
      signedRequest(
        statusPath(),
        { CallSid: 'CA1', CallStatus: 'completed', From: '+15551230000', Secretish: 'zz-body-zz' },
        { signature: 'zz-signature-zz' }
      )
    )
    await send(status('completed', { From: '+15551230000' }))
    const logs = t.deps.logLines.join('\n')
    for (const secret of ['zz-body-zz', 'zz-signature-zz', '+15551230000', '15551230000']) {
      expect(logs).not.toContain(secret)
    }
  })
})

describe('POST /webhooks/twilio/recording', () => {
  const recording = (recordingStatus: string) =>
    signedRequest(recordingPath(), {
      CallSid: 'CA1',
      RecordingSid: `RE${'2'.repeat(32)}`,
      RecordingStatus: recordingStatus,
    })

  test('a completed recording is recorded once', async () => {
    expect((await send(recording('completed'))).status).toBe(200)
    expect((await send(recording('completed'))).status).toBe(200)
    expect(t.deps.callEvents.recorded).toHaveLength(1)
  })

  test('a completed recording queues a finishing job, an in-progress one does not', async () => {
    expect((await send(recording('in-progress'))).status).toBe(200)
    expect(t.deps.jobs.depth().visible).toBe(0)
    expect((await send(recording('completed'))).status).toBe(200)
    expect(t.deps.jobs.depth().visible).toBe(1)
  })

  test('an in-progress recording is acknowledged without a record', async () => {
    expect((await send(recording('in-progress'))).status).toBe(200)
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })

  test('a bad signature answers 403 and records nothing', async () => {
    const request = signedRequest(
      recordingPath(),
      { CallSid: 'CA1', RecordingSid: 'RE1', RecordingStatus: 'completed' },
      { signature: 'nope' }
    )
    expect((await send(request)).status).toBe(403)
    expect(t.deps.callEvents.recorded).toHaveLength(0)
  })
})
