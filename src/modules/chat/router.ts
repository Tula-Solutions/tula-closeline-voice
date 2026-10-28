import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  publicChatConsentReceiptSchema,
  publicChatConsentRequestSchema,
  publicChatConsentWordingSchema,
  publicChatHeadersSchema,
  publicChatKeyParamsSchema,
  publicChatMessagePageSchema,
  publicChatMessageReplySchema,
  publicChatOriginHeadersSchema,
  publicChatSessionParamsSchema,
  publicListChatMessagesQuerySchema,
  publicSendChatMessageRequestSchema,
  publicStartChatRequestSchema,
  publicStartChatResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import { chatCors } from './cors'
import * as Chats from './service'

const PUBLIC =
  'Public: it carries no access token. The publishable key or the session token in the path ' +
  'stands in for it, and the `Origin` must be one the Organization allows. '
const serverError = errorResponse('Something went wrong on our side.')
const replayErrors = errorResponse(
  'request.idempotency_in_progress (409), or chat.session_closed: the Chat has ended.'
)
const limited = errorResponse('rate.limited: too many requests; see Retry-After.')
const body = <S extends z.ZodType>(description: string, schema: S) => ({
  description,
  content: { 'application/json': { schema } },
})

/** What `Bun.serve` hands the app: where the socket address of the caller is read. */
type ClientBindings = { requestIP?: (request: Request) => { address: string } | null }

const startChat = createRoute({
  method: 'post',
  path: '/v1/public/chat/{key}/sessions',
  tags: ['chat'],
  summary: 'Start a website Chat',
  description:
    `${PUBLIC}Starts a Chat and returns the session token and the first message, which says the ` +
    'visitor is talking to an AI. The same `Idempotency-Key` returns the same session (200). A ' +
    'filled `website` field is answered like a start, but nothing is stored.',
  request: {
    params: publicChatKeyParamsSchema,
    headers: publicChatHeadersSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: publicStartChatRequestSchema } },
    },
  },
  responses: {
    200: body('The session this Idempotency-Key started earlier.', publicStartChatResponseSchema),
    201: body('The new session.', publicStartChatResponseSchema),
    400: errorResponse('request.invalid'),
    403: errorResponse('chat.origin_not_allowed'),
    404: errorResponse('chat.key_invalid'),
    422: errorResponse('request.idempotency_key_reused'),
    429: limited,
    500: serverError,
  },
})

const sendMessage = createRoute({
  method: 'post',
  path: '/v1/public/chat/sessions/{sessionToken}/messages',
  tags: ['chat'],
  summary: 'Send a Chat message and get the reply',
  description:
    `${PUBLIC}The visitor's text is untrusted data for the Agent, never an instruction. The same ` +
    '`Idempotency-Key` with the same text answers the first reply and asks the model nothing.',
  request: {
    params: publicChatSessionParamsSchema,
    headers: publicChatHeadersSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: publicSendChatMessageRequestSchema } },
    },
  },
  responses: {
    200: body("The Agent's reply.", publicChatMessageReplySchema),
    400: errorResponse('request.invalid'),
    403: errorResponse('chat.origin_not_allowed'),
    404: errorResponse('chat.session_not_found'),
    409: replayErrors,
    422: errorResponse('request.idempotency_key_reused'),
    429: limited,
    500: serverError,
  },
})

const listMessages = createRoute({
  method: 'get',
  path: '/v1/public/chat/sessions/{sessionToken}/messages',
  tags: ['chat'],
  summary: 'List the messages of a Chat',
  description: `${PUBLIC}Oldest first, cursor pagination, at most 100 per page. Message 0 is the AI disclosure.`,
  request: {
    params: publicChatSessionParamsSchema,
    headers: publicChatOriginHeadersSchema,
    query: publicListChatMessagesQuerySchema,
  },
  responses: {
    200: body('One page of messages.', publicChatMessagePageSchema),
    400: errorResponse('request.invalid: the query or the cursor is not valid.'),
    403: errorResponse('chat.origin_not_allowed'),
    404: errorResponse('chat.session_not_found'),
    409: errorResponse('chat.session_closed'),
    500: serverError,
  },
})

const callbackConsent = createRoute({
  method: 'post',
  path: '/v1/public/chat/sessions/{sessionToken}/callback-consent',
  tags: ['chat'],
  summary: 'Leave a name and phone, with or without agreeing to a callback',
  description:
    `${PUBLIC}Records the Consent Wording id and version the visitor saw. A wording that is not ` +
    'the current one is chat.consent_wording_missing and nothing is recorded. The Chat becomes an ' +
    'Inquiry; without the callback box ticked the details are kept and no call is placed.',
  request: {
    params: publicChatSessionParamsSchema,
    headers: publicChatHeadersSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: publicChatConsentRequestSchema } },
    },
  },
  responses: {
    200: body('The consent this Idempotency-Key recorded earlier.', publicChatConsentReceiptSchema),
    201: body('The consent was recorded.', publicChatConsentReceiptSchema),
    400: errorResponse('request.invalid'),
    403: errorResponse('chat.origin_not_allowed'),
    404: errorResponse('chat.session_not_found'),
    409: replayErrors,
    422: errorResponse('chat.consent_wording_missing, or request.idempotency_key_reused.'),
    500: serverError,
  },
})

const consentWording = createRoute({
  method: 'get',
  path: '/v1/public/chat/{key}/consent-wording',
  tags: ['chat'],
  summary: 'Read the current callback consent wording',
  description:
    `${PUBLIC}Answers the id and version of the Consent Wording the callback box must show now. ` +
    'Send both back with the callback request.',
  request: { params: publicChatKeyParamsSchema, headers: publicChatOriginHeadersSchema },
  responses: {
    200: body('The current wording.', publicChatConsentWordingSchema),
    400: errorResponse('request.invalid'),
    403: errorResponse('chat.origin_not_allowed'),
    404: errorResponse('chat.key_invalid'),
    429: limited,
    500: serverError,
  },
})

/** The public Chat routes (spec M14): a website visitor chats with the Inbound Agent. */
export function createChatRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter<AppEnv>()
  router.use('/v1/public/chat/*', chatCors(container))
  router.openapi(startChat, async (c) => {
    const headers = c.req.valid('header')
    const input = c.req.valid('json')
    const result = await Chats.start(container, {
      key: c.req.valid('param').key,
      origin: headers.origin,
      idempotencyKey: headers['idempotency-key'],
      sourceUrl: input.sourceUrl,
      honeypot: input.website,
      address: {
        socketAddress: (c.env as ClientBindings | undefined)?.requestIP?.(c.req.raw)?.address,
        forwardedFor: c.req.header('x-forwarded-for'),
      },
    })
    return result.replayed ? c.json(result.body, 200) : c.json(result.body, 201)
  })
  router.openapi(consentWording, async (c) =>
    c.json(
      await Chats.consentWording(container, {
        key: c.req.valid('param').key,
        origin: c.req.valid('header').origin,
        address: {
          socketAddress: (c.env as ClientBindings | undefined)?.requestIP?.(c.req.raw)?.address,
          forwardedFor: c.req.header('x-forwarded-for'),
        },
      }),
      200
    )
  )
  router.openapi(sendMessage, async (c) => {
    const headers = c.req.valid('header')
    const result = await Chats.send(container, {
      token: c.req.valid('param').sessionToken,
      origin: headers.origin,
      idempotencyKey: headers['idempotency-key'],
      text: c.req.valid('json').text,
    })
    return c.json(result.body, 200)
  })
  router.openapi(listMessages, async (c) => {
    const query = c.req.valid('query')
    return c.json(
      await Chats.listMessages(container, {
        token: c.req.valid('param').sessionToken,
        origin: c.req.valid('header').origin,
        cursor: query.cursor,
        limit: query.limit,
      }),
      200
    )
  })
  router.openapi(callbackConsent, async (c) => {
    const headers = c.req.valid('header')
    const result = await Chats.recordConsent(container, {
      token: c.req.valid('param').sessionToken,
      origin: headers.origin,
      idempotencyKey: headers['idempotency-key'],
      request: c.req.valid('json'),
    })
    return result.replayed ? c.json(result.body, 200) : c.json(result.body, 201)
  })
  return router
}
