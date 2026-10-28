import { type Container, reportSafely } from '~/container'
import { internalErrorResponse } from '~/http/errors'
import { resolveRequestId } from '~/http/request-id'
import {
  type AgentMediaContext,
  authorizeAgentMedia,
  createAgentMediaSession,
} from '~/modules/agent-media/session'
import {
  authorizeMedia,
  createMediaSession,
  type MediaContext,
  type MediaSession,
} from '~/modules/media/handler'

/** The part of the app that the server needs. */
type Fetcher = { fetch: (request: Request) => Response | Promise<Response> }

/** What rides on each media socket: the Call it was signed for and its session once open. */
export type MediaSocketData = {
  context: MediaContext
  /** Set on an Agent Call's socket, which `context` then repeats. */
  agent?: AgentMediaContext
  session?: MediaSession
}

/** The largest media frame accepted; the provider's are a few hundred bytes. */
export const MEDIA_MAX_FRAME_BYTES = 16_384
/** Seconds of silence after which a media socket is closed; the provider sends audio every 20 ms. */
export const MEDIA_IDLE_SECONDS = 60

/**
 * How far above the app's limit `Bun.serve`'s own limit sits. A client that is just over the app's
 * limit then reaches the app and gets the contract's 413 with a request id, instead of Bun's bare
 * one. The app's check reads the `content-length` header, so it is advisory; the bytes are held
 * to the limit by the stream cut-off in the body-limit middleware (a body with no length) and by
 * Bun, which refuses anything over its own limit and never reads past a declared length.
 *
 * Accepted residual: a body larger than the app limit plus this margin never reaches the app. Bun
 * answers it with its own bare 413, with no body and no request id, whether the body is chunked
 * or declared. That response cannot carry the contract's error shape, and the cost of making it
 * do so (reading the excess) is the work the limit exists to avoid.
 */
export const BODY_LIMIT_MARGIN_BYTES = 65_536

/**
 * The options `Bun.serve` runs the app with. `development` follows `ENVIRONMENT`, never `NODE_ENV`.
 * The `error` hook is the last line of defence for a failure outside the app: it reports once and
 * answers with the contract's 500 body instead of Bun's own page.
 */
export function serveOptions(container: Container, app: Fetcher) {
  return {
    port: container.env.PORT,
    fetch: async (
      request: Request,
      server: { upgrade: (request: Request, options: { data: MediaSocketData }) => boolean }
    ): Promise<Response | undefined> => {
      const agent = await authorizeAgentMedia(container, request)
      if (agent instanceof Response) {
        return agent
      }
      if (agent !== undefined) {
        return server.upgrade(request, { data: { context: agent, agent } })
          ? undefined
          : new Response(null, { status: 400 })
      }
      const media = await authorizeMedia(container, request)
      if (media === undefined) {
        return app.fetch(request)
      }
      if (media instanceof Response) {
        return media
      }
      return server.upgrade(request, { data: { context: media } })
        ? undefined
        : new Response(null, { status: 400 })
    },
    websocket: {
      maxPayloadLength: MEDIA_MAX_FRAME_BYTES,
      idleTimeout: MEDIA_IDLE_SECONDS,
      open: (ws: Bun.ServerWebSocket<MediaSocketData>) => {
        const { agent, context } = ws.data
        ws.data.session =
          agent === undefined
            ? createMediaSession(container, context, ws)
            : createAgentMediaSession(container, agent, ws)
      },
      message: async (ws: Bun.ServerWebSocket<MediaSocketData>, data: string | Buffer) => {
        await ws.data.session?.message(data)
      },
      close: async (ws: Bun.ServerWebSocket<MediaSocketData>) => {
        await ws.data.session?.closed()
      },
    },
    maxRequestBodySize: container.env.MAX_REQUEST_BODY_BYTES + BODY_LIMIT_MARGIN_BYTES,
    development: container.env.ENVIRONMENT === 'local',
    error: (error: unknown): Response => {
      const requestId = resolveRequestId(undefined)
      reportSafely(container, error, { requestId, method: 'UNKNOWN', path: 'UNKNOWN', status: 500 })
      return internalErrorResponse(requestId)
    },
  }
}
