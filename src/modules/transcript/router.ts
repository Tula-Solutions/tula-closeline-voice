import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { stream } from 'hono/streaming'
import {
  COPILOT_ERRORS,
  type CopilotStreamMessage,
  copilotCallParamsSchema,
  copilotStreamHeadersSchema,
  formatCopilotStreamFrame,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Calls from '~/modules/call/service'
import { MAX_TURN_PAGE, type TurnCursor } from '~/ports/call-turn-store'

const MAX_POLLS = 86_400

const streamRoute = createRoute({
  method: 'get',
  path: '/calls/{callId}/copilot/stream',
  tags: ['copilot'],
  summary: 'Stream the live Transcript of a Call',
  description:
    'Server-Sent Events: copilot.status, then transcript.turn for each final turn in order, and ' +
    'transcript.unavailable if speech-to-text fails (the Call goes on). Opens once the Call is ' +
    'disclosing and says waiting_for_disclosure until an AI-assisted Disclosure has played. ' +
    '`Last-Event-ID` resumes from what is stored. A Call the caller may not see, or of another ' +
    'Organization, is call.not_found. Turn text is untrusted data.',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: copilotCallParamsSchema, headers: copilotStreamHeadersSchema },
  responses: {
    200: {
      description: 'The event stream.',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    400: errorResponse('request.invalid'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found'),
    409: errorResponse(
      'copilot.not_started: the Call is still ringing or connecting. copilot.disabled: the Call ' +
        'has no Copilot.'
    ),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: the directory did not answer.'),
  },
})

const cursorId = (c: TurnCursor): string => `r${c.rep}.p${c.prospect}`

function parseCursor(id: string | undefined): TurnCursor {
  const match = /^r(\d{1,9})\.p(\d{1,9})$/.exec(id ?? '')
  return match ? { rep: Number(match[1]), prospect: Number(match[2]) } : { rep: 0, prospect: 0 }
}

/** The live Transcript stream of a Call. Mounted behind the access-token middleware. */
export function createTranscriptRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(streamRoute, async (c) => {
    const caller = callerOf(c)
    const { callId } = c.req.valid('param')
    const first = await Calls.get(container, caller, callId)
    if (
      first.repMembershipId === null ||
      (first.disclosure.playedAt && !first.disclosure.aiAssisted)
    ) {
      throw domainError(COPILOT_ERRORS['copilot.disabled'])
    }
    if (first.state === 'ringing' || first.state === 'connecting') {
      throw domainError(COPILOT_ERRORS['copilot.not_started'])
    }
    const org = caller.organizationId
    const cursor = parseCursor(c.req.valid('header')['last-event-id'])
    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    return stream(c, async (s) => {
      let aborted = false
      s.onAbort(() => {
        aborted = true
      })
      const send = (message: Omit<CopilotStreamMessage, 'id'>) =>
        s.write(
          formatCopilotStreamFrame({ ...message, id: cursorId(cursor) } as CopilotStreamMessage)
        )
      let delivered = cursor.rep + cursor.prospect
      let said = ''
      let sentUnavailable = false
      for (let poll = 0; poll < MAX_POLLS && !aborted; poll++) {
        const call = await container.calls.get(org, callId)
        const over = call === undefined || ['ended', 'failed', 'missed'].includes(call.state)
        const refused = call?.disclosure.playedAt && !call.disclosure.aiAssisted
        const reason = container.copilot.unavailable.get(callId)
        const state =
          over || refused ? 'ended' : call.disclosure.playedAt ? 'live' : 'waiting_for_disclosure'
        const status = `${state}|${reason ?? ''}`
        const turns = refused
          ? []
          : await container.callTurns.list(org, callId, cursor, MAX_TURN_PAGE)
        if (status !== said && (turns.length === 0 || said === '')) {
          said = status
          await send({
            event: 'copilot.status',
            data: {
              callId,
              state,
              quietReason: reason ? 'transcript_unavailable' : null,
            },
          } as never)
        }
        for (const turn of turns) {
          cursor[turn.track] = turn.sequence
          delivered += 1
          await send({
            event: 'transcript.turn',
            data: {
              callId,
              sequence: delivered,
              turn: {
                speaker: turn.track,
                startMs: turn.startMs,
                endMs: turn.endMs,
                text: turn.text,
              },
            },
          } as never)
        }
        if (reason && !sentUnavailable && turns.length === 0) {
          sentUnavailable = true
          await send({ event: 'transcript.unavailable', data: { callId, reason } } as never)
        }
        if (state === 'ended' && turns.length === 0) {
          return
        }
        if (turns.length < MAX_TURN_PAGE) {
          await Bun.sleep(container.copilot.pollMs)
        }
      }
    }) as never
  })

  return router
}
