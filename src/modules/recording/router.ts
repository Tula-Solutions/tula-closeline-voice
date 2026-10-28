import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  organizationIdSchema,
  recordingPlaybackSchema,
  voiceCallParamsSchema,
  voiceCallSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { internalAuth } from '~/http/internal-auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY, PUBLIC_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import * as Recordings from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const unauthorized = errorResponse('The access token is missing, expired or not valid.')
const serverError = errorResponse('Something went wrong on our side.')

const play = createRoute({
  method: 'get',
  path: '/calls/{callId}/recording',
  tags: ['recordings'],
  summary: "Get a short-lived URL to play a Call's Recording",
  description:
    'Any voice role, for the Calls the caller may see. The URL expires after a few minutes and ' +
    'is a bearer credential: do not store or log it. `recording.not_ready` while the copy is ' +
    'being made; `recording.not_found` when there is none or it was deleted.',
  security,
  request: { params: voiceCallParamsSchema },
  responses: {
    200: {
      description: 'A URL that plays the Recording until `expiresAt`.',
      content: { 'application/json': { schema: recordingPlaybackSchema } },
    },
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found, or recording.not_found'),
    409: errorResponse('recording.not_ready'),
    500: serverError,
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/calls/{callId}/recording',
  tags: ['recordings'],
  summary: "Delete a Call's Recording",
  description:
    'Owner or Admin. The Recording stops being playable at once and its file is removed after ' +
    'the purge delay. Deleting it again answers the same Call.',
  security,
  request: { params: voiceCallParamsSchema },
  responses: {
    200: {
      description: 'The Call, its `recordingState` now `deleted`.',
      content: { 'application/json': { schema: voiceCallSchema } },
    },
    401: unauthorized,
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found, or recording.not_found'),
    409: errorResponse('call.not_ended'),
    500: serverError,
  },
})

/** The Recording routes of the public API. */
export function createRecordingRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(play, async (c) => {
    const { callId } = c.req.valid('param')
    c.header('cache-control', 'no-store')
    return c.json(await Recordings.playback(container, callerOf(c), callId), 200)
  })
  router.openapi(remove, async (c) => {
    const { callId } = c.req.valid('param')
    return c.json(await Recordings.remove(container, callerOf(c), callId), 200)
  })
  return router
}

const open = createRoute({
  method: 'get',
  path: '/internal/v1/calls/{callId}/recording',
  tags: ['internal'],
  summary: "Read a Call's Recording file",
  description:
    "Internal, called with the shared secret (ADR 0013), for the transcription pipeline. The Organization is the `X-Organization-Id` header. Streams the stored audio; a Call or Recording that is not the Organization's is not found. The audio is a Prospect's voice: never logged.",
  security: [{ [INTERNAL_SECURITY]: [] }],
  request: {
    headers: z.object({ 'x-organization-id': organizationIdSchema }),
    params: voiceCallParamsSchema,
  },
  responses: {
    200: {
      description: 'The audio.',
      content: { 'audio/wav': { schema: z.string().meta({ format: 'binary' }) } },
    },
    400: errorResponse('request.invalid'),
    401: errorResponse('auth.unauthenticated: the shared secret is missing or wrong.'),
    404: errorResponse('call.not_found, or recording.not_found'),
    409: errorResponse('recording.not_ready'),
    500: serverError,
  },
})

/** The internal Recording read, behind the ADR 0013 shared secret. */
export function createInternalRecordingRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.use('/internal/v1/*', internalAuth(container.env.INTERNAL_API_TOKENS))
  router.openapi(open, async (c) => {
    const { callId } = c.req.valid('param')
    const object = await Recordings.open(
      container,
      c.req.valid('header')['x-organization-id'],
      callId
    )
    return new Response(object.body, {
      status: 200,
      headers: {
        'content-type': 'audio/wav',
        'cache-control': 'no-store',
        ...(object.size === null ? {} : { 'content-length': String(object.size) }),
      },
    }) as never
  })
  return router
}
