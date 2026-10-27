import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  listVoiceCallsQuerySchema,
  placeCallHeadersSchema,
  placeCallRequestSchema,
  placedCallSchema,
  voiceCallPageSchema,
  voiceCallParamsSchema,
  voiceCallSchema,
  wrapUpRequestSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse, errorResponseWithRetryAfter } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Calls from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const unauthorized = errorResponse('The access token is missing, expired or not valid.')
const serverError = errorResponse('Something went wrong on our side.')

const callBody = (description: string) => ({
  description,
  content: { 'application/json': { schema: voiceCallSchema } },
})

const placedBody = (description: string) => ({
  description,
  content: { 'application/json': { schema: placedCallSchema } },
})

const place = createRoute({
  method: 'post',
  path: '/calls',
  tags: ['calls'],
  summary: 'Place a Call to a Prospect',
  description:
    'Any voice role. Needs an `Idempotency-Key`: the same key with the same request places one ' +
    'Call and answers 200 with it, for 24 hours. The Disclosure plays before the Rep is bridged ' +
    'and before the recording starts, on every Call; there is no setting for it. A Contact Check ' +
    'denial is a warning on the placed Call, never a refusal.',
  security,
  request: {
    headers: placeCallHeadersSchema,
    body: { required: true, content: { 'application/json': { schema: placeCallRequestSchema } } },
  },
  responses: {
    200: placedBody('The Call this Idempotency-Key placed earlier; nothing was dialled again.'),
    201: placedBody('The Call, `live` once the Disclosure has played and the Rep is bridged.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('line.not_found'),
    409: errorResponseWithRetryAfter(
      'call.line_unavailable, or request.idempotency_in_progress while the first request with ' +
        'this Idempotency-Key is still running (send it again after Retry-After).'
    ),
    422: errorResponse(
      'call.number_invalid, or request.idempotency_key_reused: the key was used for another request.'
    ),
    500: serverError,
    502: errorResponse('call.disclosure_failed: the Disclosure did not play; the Call failed.'),
    503: errorResponse('server.unavailable: the telephony provider did not answer.'),
  },
})

const list = createRoute({
  method: 'get',
  path: '/calls',
  tags: ['calls'],
  summary: 'List Calls',
  description:
    'A Rep sees their own Calls, a Manager their own and their Team Reps, an Owner or Admin all. ' +
    'Newest first, cursor pagination, at most 100 per page.',
  security,
  request: { query: listVoiceCallsQuerySchema },
  responses: {
    200: {
      description: 'One page of Calls.',
      content: { 'application/json': { schema: voiceCallPageSchema } },
    },
    400: errorResponse('request.invalid: the query or the cursor is not valid.'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    500: serverError,
    503: errorResponse('server.unavailable: the directory did not answer.'),
  },
})

const read = createRoute({
  method: 'get',
  path: '/calls/{callId}',
  tags: ['calls'],
  summary: 'Read one Call',
  description: 'A Call the caller may not see, or of another Organization, is call.not_found.',
  security,
  request: { params: voiceCallParamsSchema },
  responses: {
    200: callBody('The Call.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found'),
    500: serverError,
    503: errorResponse('server.unavailable: the directory did not answer.'),
  },
})

const wrapUp = createRoute({
  method: 'put',
  path: '/calls/{callId}/wrap-up',
  tags: ['calls'],
  summary: 'Wrap up an ended Call',
  description:
    'The Rep who took the Call, and an Owner or Admin. Links a Deal and stores a note. Anyone ' +
    'else gets call.not_found.',
  security,
  request: {
    params: voiceCallParamsSchema,
    body: { required: true, content: { 'application/json': { schema: wrapUpRequestSchema } } },
  },
  responses: {
    200: callBody('The Call with its wrap-up.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found'),
    409: errorResponse('call.not_ended: the Call is still going.'),
    500: serverError,
  },
})

const answerInbound = createRoute({
  method: 'post',
  path: '/calls/{callId}/answer',
  tags: ['calls'],
  summary: 'Answer a ringing inbound Call',
  description:
    'A Rep the Call is ringing, whether through the Line assigned to them or their Team. The ' +
    'first answer gets the Call; the Disclosure plays, then the Rep is bridged. A later answer is ' +
    "call.not_ringing. Repeating the winner's answer returns the Call as it is.",
  security,
  request: { params: voiceCallParamsSchema },
  responses: {
    200: callBody('The Call, `live` once the Disclosure has played and the Rep is bridged.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found: no such inbound Call is ringing for the caller.'),
    409: errorResponse('call.not_ringing: another Rep answered, or the Call was missed.'),
    500: serverError,
    502: errorResponse('call.disclosure_failed: the Disclosure did not play; the Call failed.'),
    503: errorResponse('server.unavailable: the telephony provider did not answer.'),
  },
})

/** The Calls of the caller's Organization. Mounted behind the access-token middleware. */
export function createCallRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(place, async (c) => {
    const answer = await Calls.place(
      container,
      callerOf(c),
      c.req.valid('json'),
      c.req.valid('header')['idempotency-key']
    )
    return answer.replayed
      ? c.json(answer.body, 200)
      : c.json({ ...answer.body, call: answer.call }, 201)
  })
  router.openapi(list, async (c) =>
    c.json(await Calls.list(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(read, async (c) =>
    c.json(await Calls.get(container, callerOf(c), c.req.valid('param').callId), 200)
  )
  router.openapi(wrapUp, async (c) =>
    c.json(
      await Calls.wrapUp(container, callerOf(c), c.req.valid('param').callId, c.req.valid('json')),
      200
    )
  )
  router.openapi(answerInbound, async (c) =>
    c.json(await Calls.answer(container, callerOf(c), c.req.valid('param').callId), 200)
  )

  return router
}
