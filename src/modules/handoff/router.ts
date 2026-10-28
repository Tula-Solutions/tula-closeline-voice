import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { handoffParamsSchema, handoffSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Handoffs from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const answerRoute = (verb: 'accept' | 'decline') =>
  createRoute({
    method: 'post',
    path: `/handoffs/{handoffId}/${verb}`,
    tags: ['handoffs'],
    summary: `${verb === 'accept' ? 'Accept' : 'Decline'} a Call offered to the caller`,
    description:
      "Owner, Admin, Manager or Rep. The Rep is the token's; the body names no one. Repeating " +
      "the same answer returns the same Handoff. Another Rep's or Organization's Handoff is " +
      '`handoff.not_found`; one that is no longer pending is `handoff.not_pending`.',
    security,
    request: { params: handoffParamsSchema },
    responses: {
      200: {
        description: 'The Handoff after the answer.',
        content: { 'application/json': { schema: handoffSchema } },
      },
      400: errorResponse('The Handoff id is not valid.'),
      401: errorResponse('The access token is missing, expired or not valid.'),
      403: errorResponse('auth.forbidden: the caller may not answer Handoffs.'),
      404: errorResponse('handoff.not_found: no such Handoff offered to the caller.'),
      409: errorResponse('handoff.not_pending: the offer was already answered or has ended.'),
      500: errorResponse('Something went wrong on our side.'),
    },
  })

const accept = answerRoute('accept')
const decline = answerRoute('decline')

/** The Handoff routes of the caller's Organization. Mounted behind the access-token middleware. */
export function createHandoffRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(accept, async (c) => {
    const { handoffId } = c.req.valid('param')
    return c.json(await Handoffs.accept(container, callerOf(c), handoffId), 200)
  })
  router.openapi(decline, async (c) => {
    const { handoffId } = c.req.valid('param')
    return c.json(await Handoffs.decline(container, callerOf(c), handoffId), 200)
  })
  return router
}
