import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { copilotSettingsSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as CopilotSettings from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const answer = {
  description: 'The settings in force.',
  content: { 'application/json': { schema: copilotSettingsSchema } },
}

// The contract's request schema bounds the minimums, which would answer 400; the ticket wants
// `copilot.min_evidence_invalid` (422), so the route takes any integers and the service judges.
const bodySchema = z.strictObject({
  enabled: z.boolean(),
  minMoments: z.number().int(),
  minDeals: z.number().int(),
})

const getRoute = createRoute({
  method: 'get',
  path: '/copilot/settings',
  tags: ['copilot'],
  summary: 'Read the Copilot settings',
  description:
    'Every role. Until an Admin saves settings the Copilot is off, with the minimums of 3 ' +
    'Moments from 2 Deals.',
  security,
  responses: {
    200: answer,
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const putRoute = createRoute({
  method: 'put',
  path: '/copilot/settings',
  tags: ['copilot'],
  summary: 'Replace the Copilot settings',
  description:
    'Owner and Admin only. Replaces the whole value, so the same values give the same settings. A minimum ' +
    'outside 1 to 20, or more Deals than Moments, is copilot.min_evidence_invalid. No setting ' +
    'touches the Disclosure (ADR 0003).',
  security,
  request: { body: { required: true, content: { 'application/json': { schema: bodySchema } } } },
  responses: {
    200: answer,
    400: errorResponse('request.invalid'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    422: errorResponse('copilot.min_evidence_invalid'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Copilot settings routes. Mounted behind the access-token middleware. */
export function createCopilotSettingsRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(getRoute, async (c) =>
    c.json(await CopilotSettings.getSettings(container, callerOf(c)), 200)
  )
  router.openapi(putRoute, async (c) =>
    c.json(await CopilotSettings.setSettings(container, callerOf(c), c.req.valid('json')), 200)
  )
  return router
}
