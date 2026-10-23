import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { softphoneTokenSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Softphone from './service'

const mint = createRoute({
  method: 'post',
  path: '/softphone/token',
  tags: ['softphone'],
  summary: 'Mint a softphone token for the caller',
  description:
    "Any role. The token lets the caller's browser register as a softphone. It is short-lived " +
    "(15 minutes), names only the caller's Membership and Organization, and is never cached: " +
    'ask again before `expiresAt`.',
  security: [{ [PUBLIC_SECURITY]: [] }],
  responses: {
    200: {
      description: 'The token.',
      content: { 'application/json': { schema: softphoneTokenSchema } },
    },
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden: the caller has no Membership in the Organization.'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: the telephony provider is not available.'),
  },
})

/** The softphone routes of the caller's Organization. Mounted behind the access-token middleware. */
export function createSoftphoneRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(mint, async (c) => {
    const token = await Softphone.mintToken(container, callerOf(c))
    c.header('cache-control', 'no-store')
    return c.json(token, 200)
  })
  return router
}
