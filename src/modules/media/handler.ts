import { callIdSchema, organizationIdSchema, type VoiceCall } from 'tula-closeline-contract'
import { MAX_AUDIO_CHUNK_BYTES } from 'tula-closeline-kit'
import type { Container } from '~/container'
import * as Transcript from '~/modules/transcript/service'
import type { TurnTrack } from '~/ports/call-turn-store'

/** What the media route needs from the container. */
export type MediaDeps = Pick<
  Container,
  | 'calls'
  | 'callTurns'
  | 'copilotCards'
  | 'copilotSettings'
  | 'evidence'
  | 'telephony'
  | 'transcribe'
  | 'copilot'
  | 'clock'
  | 'logger'
  | 'env'
>

/** The Call a media socket was signed for. */
export type MediaContext = { organizationId: string; callId: VoiceCall['id'] }

/** The part of a WebSocket the session needs: a way to hang up. */
export type MediaSocket = { close: (code?: number, reason?: string) => void }

/** The longest one media socket may stay open: the longest Call (12 hours). */
export const MEDIA_MAX_LIFETIME_MS = 43_200_000

const CLOSE_NORMAL = 1000
const CLOSE_POLICY = 1008
const CLOSE_GOING_AWAY = 1001

const refuse = (status: number): Response => new Response(null, { status })

/**
 * Decides whether a WebSocket upgrade for `/media/<callId>` may proceed. `undefined` means the
 * request is not for this route; a `Response` is the refusal to send. The provider signs the
 * route's URL (the Organization is in its path) over an empty body; the URL is rebuilt from the
 * configured origin, never from the Host header. Both the `ws` and the `http` form are tried
 * because it is not fixed which one the provider signs.
 */
export async function authorizeMedia(
  deps: MediaDeps,
  request: Request
): Promise<MediaContext | Response | undefined> {
  const url = new URL(request.url)
  const match = /^\/media\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (match === null) {
    return undefined
  }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return refuse(426)
  }
  const signature = request.headers.get('x-twilio-signature')
  const base = Transcript.mediaBase(deps.env)
  const path = url.pathname
  const signed = [base.replace(/^http/, 'ws'), base].some(
    (origin) =>
      signature !== null &&
      deps.telephony.verifyWebhook({ url: `${origin}${path}`, body: '', signature })
  )
  if (!signed) {
    deps.logger.warn('media refused: bad signature')
    return refuse(403)
  }
  const callId = callIdSchema.safeParse(match[2])
  const organizationId = organizationIdSchema.safeParse(match[1])
  if (!callId.success || !organizationId.success) {
    return refuse(404)
  }
  const call = await deps.calls.get(organizationId.data, callId.data)
  if (call === undefined || !call.copilot) {
    return refuse(404)
  }
  return { organizationId: organizationId.data, callId: callId.data }
}

/** One live media socket: feed it messages in order, tell it when the socket closed. */
export type MediaSession = {
  message: (data: string | Uint8Array) => Promise<void>
  closed: () => Promise<void>
}

type Frame = { event?: unknown; start?: { callSid?: unknown }; media?: Record<string, unknown> }

const TRACKS: Record<string, TurnTrack> = { inbound: 'prospect', outbound: 'rep' }

/**
 * The state of one Twilio Media Streams socket for one Call. `start` is checked against the
 * Call's provider id and opens the speech-to-text streams; `media` frames feed them (inbound is
 * the Prospect, outbound the Rep: the fork sits on the Prospect's leg); `stop` ends it. A socket
 * that ends any other way while the Call is still going marks the Transcript unavailable, since
 * the provider does not reconnect. The socket never outlives `lifetimeMs`.
 */
export function createMediaSession(
  deps: MediaDeps,
  context: MediaContext,
  socket: MediaSocket,
  lifetimeMs = MEDIA_MAX_LIFETIME_MS
): MediaSession {
  const { organizationId, callId } = context
  let attached = false
  let stopped = false
  let done = false
  let queue: Promise<void> = Promise.resolve()
  const timer = setTimeout(() => socket.close(CLOSE_GOING_AWAY, 'lifetime'), lifetimeMs)

  const handle = async (data: string | Uint8Array): Promise<void> => {
    let frame: Frame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
    } catch {
      socket.close(CLOSE_POLICY, 'bad frame')
      return
    }
    if (frame.event === 'start' && !attached) {
      const call = await deps.calls.get(organizationId, callId)
      if (call?.providerCallSid == null || frame.start?.callSid !== call.providerCallSid) {
        socket.close(CLOSE_POLICY, 'wrong call')
        return
      }
      if (done) {
        return
      }
      attached = await Transcript.attach(deps, organizationId, callId)
      if (!attached) {
        socket.close(CLOSE_POLICY, 'refused')
      }
    } else if (frame.event === 'media' && attached) {
      const track = TRACKS[String(frame.media?.track)]
      const payload = frame.media?.payload
      if (track === undefined || typeof payload !== 'string') {
        return
      }
      const chunk = Buffer.from(payload, 'base64')
      if (chunk.length === 0 || chunk.length > MAX_AUDIO_CHUNK_BYTES) {
        return
      }
      if (!Transcript.isOpen(deps, callId)) {
        // The Call ended and its streams closed; the provider's own stop is on its way.
        stopped = true
        socket.close(CLOSE_NORMAL, 'call over')
        return
      }
      Transcript.pushAudio(deps, callId, track, chunk)
    } else if (frame.event === 'stop') {
      stopped = true
      socket.close(CLOSE_NORMAL, 'stop')
    }
  }

  return {
    message: (data) => {
      queue = queue
        .then(() => handle(data))
        .catch((error: unknown) => {
          deps.logger.warn('media.frame_failed', {
            callId,
            code: (error as { code?: unknown }).code,
          })
          socket.close(CLOSE_POLICY, 'error')
        })
      return queue
    },
    closed: async () => {
      done = true
      clearTimeout(timer)
      await queue
      if (!attached) {
        return
      }
      await Transcript.stop(deps, callId)
      const call = await deps.calls.get(organizationId, callId)
      if (!stopped && (call?.state === 'live' || call?.state === 'disclosing')) {
        await Transcript.markUnavailable(deps, organizationId, callId, 'stream_dropped')
      }
    },
  }
}
