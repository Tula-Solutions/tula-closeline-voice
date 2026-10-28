import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { ERRORS } from 'tula-closeline-contract'
import { MAX_WEBHOOK_BODY_BYTES } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Webhooks from './service'

const outcomeSchema = z.strictObject({
  outcome: z.enum(['recorded', 'duplicate', 'ignored']),
})

const describeRoute = (path: string, summary: string) =>
  createRoute({
    method: 'post',
    path,
    tags: ['webhooks'],
    summary,
    description:
      'Called by the telephony provider, not by a client; it carries no access token. The ' +
      'provider signs the request (`X-Twilio-Signature`) and the signature is checked before ' +
      'anything else. A redelivery of the same event answers 200 and changes nothing. The body ' +
      `is a form, at most ${MAX_WEBHOOK_BODY_BYTES} bytes.`,
    responses: {
      200: {
        description: 'The callback was recorded, had been recorded before, or needs nothing.',
        content: { 'application/json': { schema: outcomeSchema } },
      },
      400: errorResponse('request.invalid: the callback names no valid Call, or is not valid.'),
      403: errorResponse('auth.forbidden: the signature is missing or does not match.'),
      404: errorResponse('call.provider_call_not_found: the Organization has no such Call.'),
      413: errorResponse('request.too_large'),
      500: errorResponse('Something went wrong on our side.'),
    },
  })

const status = describeRoute('/webhooks/twilio/status', 'Receive a call status callback')
const detection = describeRoute(
  '/webhooks/twilio/detection',
  'Receive an answering-machine detection callback'
)
const recording = describeRoute('/webhooks/twilio/recording', 'Receive a recording status callback')

const inbound = createRoute({
  method: 'post',
  path: '/webhooks/twilio/inbound',
  tags: ['webhooks'],
  summary: 'Receive an inbound call',
  description:
    'Called by the telephony provider when a Prospect calls one of our numbers; it carries no ' +
    "access token. The signature is checked first. The Line's Reps ring once however often the " +
    'provider retries, and the answer is TwiML that holds the call open while they do.',
  responses: {
    200: {
      description: 'TwiML that holds the call.',
      content: { 'text/xml': { schema: z.string() } },
    },
    400: errorResponse('request.invalid'),
    403: errorResponse('auth.forbidden: the signature is missing or does not match.'),
    413: errorResponse('request.too_large'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** Reads the raw callback off the request and hands it to the service. */
async function rawCallback(c: Context): Promise<Webhooks.RawCallback> {
  // The length the sender declares is checked before the body is read at all.
  if (Number(c.req.header('content-length') ?? 0) > MAX_WEBHOOK_BODY_BYTES) {
    throw domainError(ERRORS['request.too_large'])
  }
  const url = new URL(c.req.url)
  return {
    pathAndQuery: `${url.pathname}${url.search}`,
    body: await c.req.text(),
    signature: c.req.header('x-twilio-signature'),
  }
}

async function receiveFrom(
  container: Container,
  kind: Webhooks.CallbackKind,
  c: Context
): Promise<{ outcome: Webhooks.CallbackOutcome }> {
  return { outcome: await Webhooks.receive(container, kind, await rawCallback(c)) }
}

/** The provider's webhooks. Mounted outside the access-token middleware: the signature is the proof. */
export function createWebhookRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter<AppEnv>()
  router.openapi(status, async (c) => c.json(await receiveFrom(container, 'status', c), 200))
  router.openapi(detection, async (c) => c.json(await receiveFrom(container, 'detection', c), 200))
  router.openapi(recording, async (c) => c.json(await receiveFrom(container, 'recording', c), 200))
  router.openapi(inbound, async (c) => {
    await Webhooks.receiveInbound(container, await rawCallback(c))
    // Hold the call past the ring time; the Reps' answer bridges it, the ring timer ends it.
    const hold = Math.ceil(container.env.RING_TIMEOUT_MS / 1000) + 5
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="${hold}"/></Response>`,
      200,
      {
        'content-type': 'text/xml',
      }
    )
  })
  return router
}
