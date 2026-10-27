import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  agentSettingsSchema,
  createQualificationQuestionRequestSchema,
  listQualificationQuestionsQuerySchema,
  qualificationQuestionPageSchema,
  qualificationQuestionParamsSchema,
  qualificationQuestionSchema,
  reorderQualificationQuestionsRequestSchema,
  setAgentSettingsRequestSchema,
  updateQualificationQuestionRequestSchema,
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
import * as Agent from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const unauthorized = errorResponse('The access token is missing, expired or not valid.')
const serverError = errorResponse('Something went wrong on our side.')
const forbidden = errorResponse('auth.forbidden: the role may not do this.')
const inProgress = errorResponseWithRetryAfter(
  'request.idempotency_in_progress while the first request with this Idempotency-Key is still ' +
    'running (send it again after Retry-After).'
)
const keyHeader = (what: string) =>
  optionalIdempotencyKeyHeader(
    `A client-chosen key. The same key with the same request returns the first answer and ${what} ` +
      'again, for 24 hours; the same key with another request is ' +
      'request.idempotency_key_reused (422); the same key while the first request is still ' +
      'running is request.idempotency_in_progress (409, with Retry-After).'
  )

const questionBody = (description: string) => ({
  description,
  content: { 'application/json': { schema: qualificationQuestionSchema } },
})

const getSettings = createRoute({
  method: 'get',
  path: '/agent/settings',
  tags: ['agent'],
  summary: 'Read the Inbound Agent settings',
  description:
    'Owner, Admin and Manager; a Rep gets auth.forbidden. Until an Admin saves settings the ' +
    'answer is the defaults, with the Agent paused.',
  security,
  responses: {
    200: {
      description: 'The settings.',
      content: { 'application/json': { schema: agentSettingsSchema } },
    },
    401: unauthorized,
    403: forbidden,
    500: serverError,
  },
})

const setSettings = createRoute({
  method: 'put',
  path: '/agent/settings',
  tags: ['agent'],
  summary: 'Replace the Inbound Agent settings',
  description:
    'Owner and Admin only. Replaces the whole value, so a repeat changes nothing. There is no ' +
    'field for the Disclosure, the recording notice or Contact Consent: they are not settings ' +
    'and an unknown field is request.invalid (ADR 0003).',
  security,
  request: {
    headers: keyHeader('changes nothing'),
    body: {
      required: true,
      content: { 'application/json': { schema: setAgentSettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The settings now in force.',
      content: { 'application/json': { schema: agentSettingsSchema } },
    },
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: forbidden,
    409: inProgress,
    422: errorResponse(
      'agent.settings_invalid: the hours, the time zone or a cap is not usable; or ' +
        'request.idempotency_key_reused.'
    ),
    500: serverError,
  },
})

const listQuestions = createRoute({
  method: 'get',
  path: '/agent/questions',
  tags: ['agent'],
  summary: 'List the Qualification questions',
  description:
    'Owner, Admin and Manager. In the order the Agent asks them, cursor pagination, at most 100 ' +
    'per page.',
  security,
  request: { query: listQualificationQuestionsQuerySchema },
  responses: {
    200: {
      description: 'One page of questions.',
      content: { 'application/json': { schema: qualificationQuestionPageSchema } },
    },
    400: errorResponse('request.invalid: the query or the cursor is not valid.'),
    401: unauthorized,
    403: forbidden,
    500: serverError,
  },
})

const createQuestion = createRoute({
  method: 'post',
  path: '/agent/questions',
  tags: ['agent'],
  summary: 'Add a Qualification question',
  description:
    'Owner and Admin only. At most 50 questions; last unless a position is given. Skip logic may ' +
    'only look at earlier questions.',
  security,
  request: {
    headers: keyHeader('adds nothing'),
    body: {
      required: true,
      content: { 'application/json': { schema: createQualificationQuestionRequestSchema } },
    },
  },
  responses: {
    200: questionBody('The question this Idempotency-Key created earlier; nothing was added.'),
    201: questionBody('The new question.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: forbidden,
    409: inProgress,
    422: errorResponse('agent.question_invalid, or request.idempotency_key_reused.'),
    500: serverError,
  },
})

const readQuestion = createRoute({
  method: 'get',
  path: '/agent/questions/{questionId}',
  tags: ['agent'],
  summary: 'Read one Qualification question',
  description: 'Owner, Admin and Manager. A question of another Organization is not found.',
  security,
  request: { params: qualificationQuestionParamsSchema },
  responses: {
    200: questionBody('The question.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: forbidden,
    404: errorResponse('agent.question_not_found'),
    500: serverError,
  },
})

const updateQuestion = createRoute({
  method: 'patch',
  path: '/agent/questions/{questionId}',
  tags: ['agent'],
  summary: 'Change a Qualification question',
  description:
    'Owner and Admin only. Replaces the prompt, kind, choices, required flag and skip logic; the ' +
    'position changes by reordering.',
  security,
  request: {
    params: qualificationQuestionParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateQualificationQuestionRequestSchema } },
    },
  },
  responses: {
    200: questionBody('The question.'),
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: forbidden,
    404: errorResponse('agent.question_not_found'),
    422: errorResponse('agent.question_invalid'),
    500: serverError,
  },
})

const deleteQuestion = createRoute({
  method: 'delete',
  path: '/agent/questions/{questionId}',
  tags: ['agent'],
  summary: 'Remove a Qualification question',
  description:
    'Owner and Admin only. Refused while a later question skips on this one, until that logic ' +
    'is changed.',
  security,
  request: { params: qualificationQuestionParamsSchema },
  responses: {
    204: { description: 'The question is removed.' },
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: forbidden,
    404: errorResponse('agent.question_not_found'),
    422: errorResponse('agent.question_invalid'),
    500: serverError,
  },
})

const reorderQuestions = createRoute({
  method: 'put',
  path: '/agent/question-order',
  tags: ['agent'],
  summary: 'Set the order of the Qualification questions',
  description:
    'Owner and Admin only. List every question id once, in the new order; a repeat changes ' +
    'nothing. Answers with all the questions in that order.',
  security,
  request: {
    headers: keyHeader('changes nothing'),
    body: {
      required: true,
      content: { 'application/json': { schema: reorderQualificationQuestionsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Every question in the new order.',
      content: { 'application/json': { schema: qualificationQuestionPageSchema } },
    },
    400: errorResponse('request.invalid'),
    401: unauthorized,
    403: forbidden,
    404: errorResponse('agent.question_not_found: an id is not a question of this Organization.'),
    409: inProgress,
    422: errorResponse(
      'agent.question_invalid: a question is left out, or skip logic would look at a later ' +
        'question; or request.idempotency_key_reused.'
    ),
    500: serverError,
  },
})

/** The Inbound Agent settings and Qualification questions. Mounted behind the access-token middleware. */
export function createAgentSettingsRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(getSettings, async (c) =>
    c.json(await Agent.getSettings(container, callerOf(c)), 200)
  )
  router.openapi(setSettings, async (c) => {
    const answer = await Agent.setSettings(
      container,
      callerOf(c),
      c.req.valid('json'),
      c.req.valid('header')['idempotency-key']
    )
    return c.json(answer.body, 200)
  })
  router.openapi(listQuestions, async (c) =>
    c.json(await Agent.listQuestions(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(createQuestion, async (c) => {
    const answer = await Agent.createQuestion(
      container,
      callerOf(c),
      c.req.valid('json'),
      c.req.valid('header')['idempotency-key']
    )
    return answer.replayed ? c.json(answer.body, 200) : c.json(answer.body, 201)
  })
  router.openapi(readQuestion, async (c) =>
    c.json(await Agent.getQuestion(container, callerOf(c), c.req.valid('param').questionId), 200)
  )
  router.openapi(updateQuestion, async (c) =>
    c.json(
      await Agent.updateQuestion(
        container,
        callerOf(c),
        c.req.valid('param').questionId,
        c.req.valid('json')
      ),
      200
    )
  )
  router.openapi(deleteQuestion, async (c) => {
    await Agent.deleteQuestion(container, callerOf(c), c.req.valid('param').questionId)
    return c.body(null, 204)
  })
  router.openapi(reorderQuestions, async (c) => {
    const answer = await Agent.reorderQuestions(
      container,
      callerOf(c),
      c.req.valid('json'),
      c.req.valid('header')['idempotency-key']
    )
    return c.json(answer.body, 200)
  })

  return router
}
