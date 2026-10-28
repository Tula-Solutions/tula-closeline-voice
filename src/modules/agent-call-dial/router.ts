import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { AGENT_CALL_ERRORS, agentCallIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { internalAuth } from '~/http/internal-auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import * as Dial from './service'

const outcomeSchema = z.strictObject({
  outcome: z.enum(['dialing', 'deferred', 'blocked', 'failed']),
  callId: z.string().nullable(),
  retryAt: z.string().nullable(),
  gateCode: z.string().nullable(),
})

const route = createRoute({
  method: 'post',
  path: '/internal/v1/agent-calls/{id}/dial',
  tags: ['internal'],
  summary: 'Dial a queued Agent Call',
  description:
    'Internal, behind the shared secret (ADR 0013); the Organization is `X-Organization-Id`. The ' +
    'gate runs again, then the dial is claimed with the Line held (caps and Contact Check ' +
    'checked once more). A claimed dial places the Call; a retry after a crash dials once. The ' +
    'Agent says nothing until detection reports a human, and then the Disclosure comes first ' +
    '(ADR 0003). `deferred` carries `retryAt`; `blocked` carries `gateCode`.',
  security: [{ [INTERNAL_SECURITY]: [] }],
  request: {
    headers: z.object({ 'x-organization-id': organizationIdSchema }),
    params: z.object({ id: agentCallIdSchema }),
  },
  responses: {
    200: {
      description: 'What the dial came to.',
      content: { 'application/json': { schema: outcomeSchema } },
    },
    401: errorResponse('auth.unauthenticated: the shared secret is missing or wrong.'),
    404: errorResponse('agent_call.not_found: no such Agent Call, or it is not waiting to dial.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The internal dial route, behind the ADR 0013 shared secret. */
export function createAgentCallDialRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.use('/internal/v1/agent-calls/*', internalAuth(container.env.INTERNAL_API_TOKENS))
  router.openapi(route, async (c) => {
    const result = await Dial.dial(
      container,
      c.req.valid('header')['x-organization-id'],
      c.req.valid('param').id
    )
    if (result.kind === 'gone') {
      throw domainError(AGENT_CALL_ERRORS['agent_call.not_found'])
    }
    c.header('cache-control', 'no-store')
    return c.json(
      {
        outcome: result.kind,
        callId: result.kind === 'dialing' ? result.callId : null,
        retryAt: result.kind === 'deferred' ? result.retryAt.toISOString() : null,
        gateCode: result.kind === 'blocked' ? result.code : null,
      },
      200
    )
  })
  return router
}
