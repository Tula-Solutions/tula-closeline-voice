import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  addLineRequestSchema,
  assignLineRequestSchema,
  linePageSchema,
  lineParamsSchema,
  lineSchema,
  listLinesQuerySchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  optionalIdempotencyKeyHeader,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Lines from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const unauthorized = errorResponse('The access token is missing, expired or not valid.')
const serverError = errorResponse('Something went wrong on our side.')

const lineBody = (description: string) => ({
  description,
  content: { 'application/json': { schema: lineSchema } },
})

const list = createRoute({
  method: 'get',
  path: '/lines',
  tags: ['lines'],
  summary: "List the Organization's Lines",
  description: 'Any role. Newest first, cursor pagination, at most 100 per page.',
  security,
  request: { query: listLinesQuerySchema },
  responses: {
    200: {
      description: 'One page of Lines.',
      content: { 'application/json': { schema: linePageSchema } },
    },
    400: errorResponse('request.invalid: the query or the cursor is not valid.'),
    401: unauthorized,
    500: serverError,
    503: errorResponse('server.unavailable: the telephony provider did not answer in time.'),
  },
})

const add = createRoute({
  method: 'post',
  path: '/lines',
  tags: ['lines'],
  summary: 'Add a Line by buying or porting a number',
  description:
    'Owner and Admin only. A port is `porting` until the carrier completes it. Send an ' +
    '`Idempotency-Key` to make a retry safe: the same key with the same request answers 200 with ' +
    'the first Line and buys or ports nothing again, for 24 hours.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeader(
      'A client-chosen key. The same key with the same request returns the first Line and does ' +
        'nothing again, for 24 hours; the same key with another request is ' +
        'request.idempotency_key_reused (422); the same key while the first request is still ' +
        'running is request.idempotency_in_progress (409, with Retry-After). Without it the call ' +
        'is not protected against being repeated.'
    ),
    body: { required: true, content: { 'application/json': { schema: addLineRequestSchema } } },
  },
  responses: {
    200: lineBody('The Line this Idempotency-Key created earlier; nothing was bought or ported.'),
    201: lineBody('The new Line.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    409: errorResponseWithRetryAfter(
      'line.number_unavailable, or request.idempotency_in_progress while the first request with ' +
        'this Idempotency-Key is still running (send it again after Retry-After).'
    ),
    422: errorResponse('request.idempotency_key_reused: the key was used for another request.'),
    500: serverError,
  },
})

const read = createRoute({
  method: 'get',
  path: '/lines/{lineId}',
  tags: ['lines'],
  summary: 'Read one Line',
  description: 'Any role. A Line of another Organization is line.not_found.',
  security,
  request: { params: lineParamsSchema },
  responses: {
    200: lineBody('The Line.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    404: errorResponse('line.not_found'),
    500: serverError,
  },
})

const assign = createRoute({
  method: 'put',
  path: '/lines/{lineId}/assignment',
  tags: ['lines'],
  summary: 'Assign a Line to a Team, a Rep or nobody',
  description: 'Owner and Admin only. Setting the assignment it already has answers 200.',
  security,
  request: {
    params: lineParamsSchema,
    body: { required: true, content: { 'application/json': { schema: assignLineRequestSchema } } },
  },
  responses: {
    200: lineBody('The Line with its assignment.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('line.not_found'),
    409: errorResponse('line.released'),
    422: errorResponse('line.assignment_invalid'),
    500: serverError,
  },
})

const release = createRoute({
  method: 'post',
  path: '/lines/{lineId}/release',
  tags: ['lines'],
  summary: 'Release a Line',
  description:
    'Owner and Admin only. Gives the number back and clears the assignment. Releasing a ' +
    'released Line answers 200 with it.',
  security,
  request: { params: lineParamsSchema },
  responses: {
    200: lineBody('The released Line.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('line.not_found'),
    500: serverError,
  },
})

/** The Lines of the caller's Organization. Mounted behind the access-token middleware. */
export function createLineRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Lines.list(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(add, async (c) => {
    const answer = await Lines.add(
      container,
      callerOf(c),
      c.req.valid('json'),
      c.req.valid('header')['idempotency-key']
    )
    return answer.replayed ? c.json(answer.body, 200) : c.json(answer.body, 201)
  })
  router.openapi(read, async (c) =>
    c.json(await Lines.get(container, callerOf(c), c.req.valid('param').lineId), 200)
  )
  router.openapi(assign, async (c) =>
    c.json(
      await Lines.assign(container, callerOf(c), c.req.valid('param').lineId, c.req.valid('json')),
      200
    )
  )
  router.openapi(release, async (c) =>
    c.json(await Lines.release(container, callerOf(c), c.req.valid('param').lineId), 200)
  )

  return router
}
