import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { stream } from 'hono/streaming'
import {
  COPILOT_ERRORS,
  type CopilotStreamMessage,
  copilotCallParamsSchema,
  copilotStreamHeadersSchema,
  formatCopilotStreamFrame,
  getTranscriptQuerySchema,
  transcriptPageSchema,
  voiceCallParamsSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Calls from '~/modules/call/service'
import * as Page from '~/modules/transcript/page'
import { MAX_TURN_PAGE, type TurnCursor } from '~/ports/call-turn-store'

/** The most cards one poll sends. */
const MAX_CARD_BATCH = 20

const streamRoute = createRoute({
  method: 'get',
  path: '/calls/{callId}/copilot/stream',
  tags: ['copilot'],
  summary: 'Stream the live Transcript of a Call',
  description:
    'Server-Sent Events: copilot.status, then transcript.turn for each final turn in order, and ' +
    'copilot.card for each retrieval card (similar won-Deal Moments, with their evidence), and ' +
    'transcript.unavailable if speech-to-text fails (the Call goes on). A stream ends after a few ' +
    'minutes, so the token is checked again when the client reconnects with `Last-Event-ID`. Opens once the Call is ' +
    'disclosing and says waiting_for_disclosure until an AI-assisted Disclosure has played. ' +
    '`Last-Event-ID` resumes from what is stored. A Call the caller may not see, or of another ' +
    'Organization, is call.not_found. Turn and card text is untrusted data.',
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

const pageRoute = createRoute({
  method: 'get',
  path: '/calls/{callId}/transcript',
  tags: ['calls'],
  summary: "Read a Call's Transcript",
  description:
    "Any voice role, for the Calls the caller may see (a Rep their own, a Manager their Team's, " +
    'an Owner or Admin all). One cursor-paginated page of turns in time order. `state` is ' +
    '`pending` until the Transcript is made and `deleted` after its Recording was deleted; both ' +
    'have no turns. A Call the caller may not see, or of another Organization, is ' +
    'call.not_found. Turn text is untrusted data.',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: voiceCallParamsSchema, query: getTranscriptQuerySchema },
  responses: {
    200: {
      description: 'A page of the Transcript.',
      content: { 'application/json': { schema: transcriptPageSchema } },
    },
    400: errorResponse('request.invalid'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('call.not_found'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const cursorId = (c: TurnCursor, cards: number): string => `r${c.rep}.p${c.prospect}.c${cards}`

/** Reads `r<n>.p<m>` with an optional `.c<k>` (the last card sequence); a bad id starts over. */
function parseCursor(id: string | undefined): TurnCursor & { cards: number } {
  const match = /^r(\d{1,9})\.p(\d{1,9})(?:\.c(\d{1,9}))?$/.exec(id ?? '')
  return match
    ? { rep: Number(match[1]), prospect: Number(match[2]), cards: Number(match[3] ?? 0) }
    : { rep: 0, prospect: 0, cards: 0 }
}

/** The live Transcript stream of a Call. Mounted behind the access-token middleware. */
export function createTranscriptRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(pageRoute, async (c) => {
    const { callId } = c.req.valid('param')
    c.header('cache-control', 'no-store')
    return c.json(await Page.page(container, callerOf(c), callId, c.req.valid('query')), 200)
  })

  router.openapi(streamRoute, async (c) => {
    const caller = callerOf(c)
    const { callId } = c.req.valid('param')
    const first = await Calls.get(container, caller, callId)
    // The stored flag, so a Call dialed while the Organization had the Copilot off says so at once.
    const stored = await container.calls.get(caller.organizationId, callId)
    if (
      stored?.copilot === false ||
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
          formatCopilotStreamFrame({
            ...message,
            id: cursorId(cursor, cursor.cards),
          } as CopilotStreamMessage)
        )
      let delivered = cursor.rep + cursor.prospect
      let said = ''
      let sentUnavailable = false
      const deadline = performance.now() + container.copilot.maxStreamMs
      while (!aborted && performance.now() < deadline) {
        const call = await container.calls.get(org, callId)
        const over = call === undefined || ['ended', 'failed', 'missed'].includes(call.state)
        const refused = call?.disclosure.playedAt && !call.disclosure.aiAssisted
        const reason = call?.transcriptUnavailable ?? undefined
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
        // Cards come after the turns they follow, so a resumed stream never shows one early.
        const cards = refused
          ? []
          : await container.copilotCards.list(org, callId, cursor.cards, MAX_CARD_BATCH)
        for (const card of cards) {
          cursor.cards = card.sequence
          await send({ event: 'copilot.card', data: { card } } as never)
        }
        if (state === 'ended' && turns.length === 0 && cards.length === 0) {
          return
        }
        if (turns.length < MAX_TURN_PAGE && cards.length < MAX_CARD_BATCH) {
          await Bun.sleep(container.copilot.pollMs)
        }
      }
    }) as never
  })

  return router
}
