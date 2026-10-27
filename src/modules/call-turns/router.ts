import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { internalAuth } from '~/http/internal-auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import {
  callTurnsHeadersSchema,
  callTurnsParamsSchema,
  callTurnsQuerySchema,
  callTurnsResponseSchema,
} from './schema'
import * as CallTurns from './service'

const PATH = '/internal/v1/calls/{callId}/turns'

const read = createRoute({
  method: 'get',
  path: PATH,
  tags: ['internal'],
  summary: "Read a window of a Call's turns around one turn",
  description:
    "Internal, called by core with the shared secret (ADR 0013) so an Owner or Admin can read an assessed turn in context. The Organization is the `X-Organization-Id` header. Returns the turns from `around - window` to `around + window`, oldest first, clipped at the Call's first and last turn; `window` is at most 20 (default 5). A Call that is not the Organization's, or a turn that does not exist, is `request.not_found`. The text is tenant speech: untrusted data, never logged.",
  security: [{ [INTERNAL_SECURITY]: [] }],
  request: {
    headers: callTurnsHeadersSchema,
    params: callTurnsParamsSchema,
    query: callTurnsQuerySchema,
  },
  responses: {
    200: {
      description: 'The turns around the asked-for one.',
      content: { 'application/json': { schema: callTurnsResponseSchema } },
    },
    400: errorResponse('request.invalid: a header, the Call id or a query value is malformed.'),
    401: errorResponse('auth.unauthenticated: the shared secret is missing or wrong.'),
    404: errorResponse('request.not_found: no such Call in the Organization, or no such turn.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The internal Call-turns read, behind the ADR 0013 shared secret. */
export function createCallTurnsRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.use('/internal/v1/*', internalAuth(container.env.INTERNAL_API_TOKENS))
  router.openapi(read, async (c) => {
    const { callId } = c.req.valid('param')
    const { around, window } = c.req.valid('query')
    const body = await CallTurns.readWindow(container, {
      organizationId: c.req.valid('header')['x-organization-id'],
      callId,
      around,
      window,
    })
    c.header('cache-control', 'no-store')
    return c.json(body, 200)
  })
  return router
}
