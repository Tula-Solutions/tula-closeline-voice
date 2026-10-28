import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  copilotCallParamsSchema,
  copilotCardPageSchema,
  copilotCardParamsSchema,
  copilotCardSchema,
  listCopilotCardsQuerySchema,
  markCopilotCardRequestSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Cards from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const unauthorized = errorResponse('The access token is missing, expired or not valid.')

const listRoute = createRoute({
  method: 'get',
  path: '/calls/{callId}/copilot/cards',
  tags: ['copilot'],
  summary: 'List the Copilot Cards shown on a Call',
  description:
    "Any voice role, for the Calls the caller may see (a Rep their own, a Manager their Team's, " +
    'an Owner or Admin all). Oldest first, cursor pagination, at most 100 per page, optionally one ' +
    'kind. A Call that never had the Copilot has an empty page. Card text is untrusted data.',
  security,
  request: { params: copilotCallParamsSchema, query: listCopilotCardsQuerySchema },
  responses: {
    200: {
      description: 'One page of cards.',
      content: { 'application/json': { schema: copilotCardPageSchema } },
    },
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: the directory did not answer.'),
  },
})

const markRoute = createRoute({
  method: 'patch',
  path: '/calls/{callId}/copilot/cards/{cardId}',
  tags: ['copilot'],
  summary: 'Rate, dismiss or pin a Copilot Card',
  description:
    'Only the Rep who took the Call; for anyone else the Call is call.not_found. The body names ' +
    'the end state wanted, so a repeat answers 200 with the card unchanged and sends the same ' +
    'voice.copilot.card_rated event id again, so consumers dedupe on it. Dismissing clears the pin and pinning clears the dismissal.',
  security,
  request: {
    params: copilotCardParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: markCopilotCardRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The card as marked.',
      content: { 'application/json': { schema: copilotCardSchema } },
    },
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found, or card.not_found: the card is not on the Call.'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: the directory did not answer.'),
  },
})

/** The Copilot Card routes of a Call. Mounted behind the access-token middleware. */
export function createCardsRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(listRoute, async (c) => {
    const { callId } = c.req.valid('param')
    c.header('cache-control', 'no-store')
    return c.json(await Cards.list(container, callerOf(c), callId, c.req.valid('query')), 200)
  })
  router.openapi(markRoute, async (c) => {
    const { callId, cardId } = c.req.valid('param')
    c.header('cache-control', 'no-store')
    return c.json(
      await Cards.mark(container, callerOf(c), callId, cardId, c.req.valid('json')),
      200
    )
  })
  return router
}
