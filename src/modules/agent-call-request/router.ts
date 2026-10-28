import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  agentCallSchema,
  organizationIdSchema,
  repAgentCallHeadersSchema,
  repAgentCallRequestSchema,
  requestAgentCallRequestSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { internalAuth } from '~/http/internal-auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY, PUBLIC_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import * as AgentCalls from './service'

const body = (description: string) => ({
  description,
  content: { 'application/json': { schema: agentCallSchema } },
})

const GATE_NOTE =
  'The fixed gate runs first (ADR 0030) and nothing turns it off: a refusal is a recorded Agent ' +
  'Call answered with 201, `result` `blocked` and the code in `gateCode`; a Line cap is a ' +
  '`queued` Agent Call with `gateCode` and `retryAt`, which uses no attempt. No Call is dialed yet.'

const internal = createRoute({
  method: 'post',
  path: '/internal/v1/agent-calls',
  tags: ['internal'],
  summary: 'Ask the Agent to call a Prospect for a call Step',
  description:
    `Internal, called by outbound with the shared secret (ADR 0013). The Organization is the ` +
    `\`X-Organization-Id\` header. A known \`idempotencyKey\` answers 200 with the existing Agent ` +
    `Call. ${GATE_NOTE} A Prospect with an Agent Call already queued, dialing or live is ` +
    `agent_call.duplicate (409, \`details.agentCallId\`).`,
  security: [{ [INTERNAL_SECURITY]: [] }],
  request: {
    headers: z.object({ 'x-organization-id': organizationIdSchema }),
    body: {
      required: true,
      content: { 'application/json': { schema: requestAgentCallRequestSchema } },
    },
  },
  responses: {
    200: body('The Agent Call this key created earlier.'),
    201: body('The new Agent Call, queued, deferred or blocked.'),
    400: errorResponse('request.invalid'),
    401: errorResponse('auth.unauthenticated: the shared secret is missing or wrong.'),
    404: errorResponse('prospect.not_found, or line.not_found.'),
    409: errorResponse('agent_call.duplicate'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: core could not be reached.'),
  },
})

const rep = createRoute({
  method: 'post',
  path: '/agent-calls',
  tags: ['agent-calls'],
  summary: 'Ask the Agent to call a Prospect now',
  description:
    `Owner, Admin, Manager and Rep, for a Prospect the caller can see (anything else is ` +
    `prospect.not_found). Needs an \`Idempotency-Key\`; a retry answers 200 with the first Agent ` +
    `Call, the same key for another Prospect is request.idempotency_key_reused (422), and a key ` +
    `with a colon is request.invalid. The Rep's request does not waive the Contact Check. ${GATE_NOTE}`,
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: repAgentCallHeadersSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: repAgentCallRequestSchema } },
    },
  },
  responses: {
    200: body('The Agent Call this Idempotency-Key created earlier.'),
    201: body('The new Agent Call, queued, deferred or blocked.'),
    400: errorResponse('request.invalid'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found, or line.not_found.'),
    409: errorResponse('agent_call.duplicate'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: core could not be reached.'),
  },
})

/** The internal Agent Call request, behind the ADR 0013 shared secret. */
export function createAgentCallInternalRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.use('/internal/v1/agent-calls', internalAuth(container.env.INTERNAL_API_TOKENS))
  router.openapi(internal, async (c) => {
    const { call, created } = await AgentCalls.requestFromOutbound(
      container,
      c.req.valid('header')['x-organization-id'],
      c.req.valid('json')
    )
    c.header('cache-control', 'no-store')
    return created ? c.json(call, 201) : c.json(call, 200)
  })
  return router
}

/** The Rep's Agent Call request. Mounted behind the access-token middleware. */
export function createAgentCallRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(rep, async (c) => {
    const { call, created } = await AgentCalls.requestFromRep(
      container,
      callerOf(c),
      c.req.valid('header')['idempotency-key'],
      c.req.valid('json')
    )
    c.header('cache-control', 'no-store')
    return created ? c.json(call, 201) : c.json(call, 200)
  })
  return router
}
