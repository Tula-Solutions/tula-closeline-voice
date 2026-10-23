import { expect, test } from 'bun:test'
import { createApp } from '../src/app'
import {
  createStubbedTwilio,
  newCallId,
  signedRequest,
  TEST_BASE_URL,
} from '../src/modules/webhook/twilio-fixture'
import { createTestDeps, newOrganizationId } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The provider webhook handler is a hot path: Twilio calls it for every status change of every
// Call, so it must stay O(1) in the size of the Organization. One request is: a body-size check,
// one HMAC-SHA1 over the URL and form, one query parse, and one idempotent insert (a unique key,
// not a scan). The memory store here stands in for that insert; the Postgres one is a single
// `insert ... on conflict do nothing` by the same key, covered by its integration test.
// Typical best batch: 11.5 ms for 500 requests (about 0.023 ms each, including signing the test
// request). Budget: 5x, rounded up. A regression of about 0.1 ms per request fails.
const BUDGET_MS = 60

test(`webhook status: the best of ${BATCHES} batches of ${BATCH_REQUESTS} requests is within ${BUDGET_MS} ms`, async () => {
  const deps = createTestDeps({
    env: { WEBHOOK_BASE_URL: TEST_BASE_URL },
    telephony: createStubbedTwilio(),
  })
  const app = createApp(deps)
  const organizationId = newOrganizationId()
  const callId = newCallId()
  deps.callEvents.addCall(organizationId, callId)
  const path = `/webhooks/twilio/status?organizationId=${organizationId}&callId=${callId}`
  let sequence = 0

  // Every request is a new event (a new sequence number), so each one reaches the store: a
  // duplicate would stop at the key and flatter the number.
  const result = await measure(() => {
    sequence += 1
    const request = signedRequest(path, {
      CallSid: `CA${'1'.repeat(32)}`,
      CallStatus: 'completed',
      SequenceNumber: String(sequence),
    })
    return app.request(request.path, request.init)
  })

  console.log(summary('webhook-status', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
