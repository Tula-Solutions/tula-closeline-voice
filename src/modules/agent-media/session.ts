import {
  callIdSchema,
  type OrganizationId,
  organizationIdSchema,
  type VoiceCall,
} from 'tula-closeline-contract'
import {
  MAX_AUDIO_CHUNK_BYTES,
  type StreamEvent,
  type TranscribeStream,
  type TtsAudioChunk,
} from 'tula-closeline-kit'
import type { Container } from '~/container'
import * as Dial from '~/modules/agent-call-dial/service'
import { MEDIA_MAX_LIFETIME_MS, type MediaSession, type MediaSocket } from '~/modules/media/handler'
import * as Transcript from '~/modules/transcript/service'

/** What the Agent's media route needs: the dialer's deps, speech-to-text and a way to wait. */
export type AgentMediaDeps = Dial.DialDeps & Pick<Container, 'transcribe' | 'sleep'>

/** The Call an Agent media socket was signed for; `talk` is the stream the Agent hears and speaks on. */
export type AgentMediaContext = {
  organizationId: OrganizationId
  callId: VoiceCall['id']
  talk: boolean
}

/** The part of a WebSocket the session needs: a way to send a frame and to hang up. */
export type AgentMediaSocket = MediaSocket & { send: (data: string) => void }

const CLOSE_NORMAL = 1000
const CLOSE_POLICY = 1008
const CLOSE_GOING_AWAY = 1001

/** How long a post-Disclosure stream waits for the Call to go live before it gives up. */
export const LIVE_WAIT_MS = 10_000
const LIVE_POLL_MS = 250
/** The audio sent to the provider in one frame: 400 ms of mu-law at 8 kHz. */
const OUTBOUND_FRAME_BYTES = 3_200

const refuse = (status: number): Response => new Response(null, { status })

/**
 * Decides whether a WebSocket upgrade for `/media/agent-calls/<orgId>/<callId>[/talk]` may proceed.
 * `undefined` means the request is not for this route; a `Response` is the refusal to send. The
 * provider signs the route's URL over an empty body; the URL is rebuilt from the configured origin,
 * never from the Host header, and the `ws` and `http` forms are both tried. The Call must be an
 * Agent Call of that Organization.
 */
export async function authorizeAgentMedia(
  deps: AgentMediaDeps,
  request: Request
): Promise<AgentMediaContext | Response | undefined> {
  const url = new URL(request.url)
  const match = /^\/media\/agent-calls\/([^/]+)\/([^/]+?)(\/talk)?$/.exec(url.pathname)
  if (match === null) {
    return undefined
  }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return refuse(426)
  }
  const signature = request.headers.get('x-twilio-signature')
  const base = Transcript.mediaBase(deps.env)
  const signed = [base.replace(/^http/, 'ws'), base].some(
    (origin) =>
      signature !== null &&
      deps.telephony.verifyWebhook({ url: `${origin}${url.pathname}`, body: '', signature })
  )
  if (!signed) {
    deps.logger.warn('agent media refused: bad signature')
    return refuse(403)
  }
  const organizationId = organizationIdSchema.safeParse(match[1])
  const callId = callIdSchema.safeParse(match[2])
  if (!organizationId.success || !callId.success) {
    return refuse(404)
  }
  if ((await deps.agentCalls.byCallId(organizationId.data, callId.data)) === undefined) {
    return refuse(404)
  }
  return { organizationId: organizationId.data, callId: callId.data, talk: match[3] !== undefined }
}

type Frame = {
  event?: unknown
  start?: { callSid?: unknown; streamSid?: unknown }
  media?: Record<string, unknown>
}

/** Seconds of speech in a settled turn, from its word timings; 0 when it has none. */
function speechSeconds(event: Extract<StreamEvent, { type: 'turn' }>): number {
  const first = event.words[0]
  const last = event.words[event.words.length - 1]
  return first === undefined || last === undefined
    ? 0
    : Math.max(0, (last.endMs - first.startMs) / 1000)
}

/**
 * The state of one Twilio Media Streams socket of an Agent Call. The first stream (before the
 * detection verdict) is accepted and left idle. The `/talk` stream opens after the Disclosure: it
 * waits for the Call to be live, opens one speech-to-text stream on what the Prospect says, speaks
 * the opening, then feeds each settled Prospect turn to the Agent and sends its speech back as
 * media frames. A Prospect who talks over the Agent cuts the speech and clears the provider's
 * buffer. The socket never outlives `lifetimeMs`. Nothing said is logged.
 */
export function createAgentMediaSession(
  deps: AgentMediaDeps,
  context: AgentMediaContext,
  socket: AgentMediaSocket,
  lifetimeMs = MEDIA_MAX_LIFETIME_MS
): MediaSession {
  const { organizationId, callId } = context
  let streamSid: string | undefined
  let started = false
  let attached = false
  let done = false
  let stream: TranscribeStream | undefined
  let speaking: AbortController | undefined
  let frames: Promise<void> = Promise.resolve()
  let turns: Promise<void> = Promise.resolve()
  const timer = setTimeout(() => socket.close(CLOSE_GOING_AWAY, 'lifetime'), lifetimeMs)

  const write = (chunk: TtsAudioChunk): void => {
    if (streamSid === undefined || done) {
      return
    }
    for (let at = 0; at < chunk.audio.length; at += OUTBOUND_FRAME_BYTES) {
      const payload = Buffer.from(chunk.audio.subarray(at, at + OUTBOUND_FRAME_BYTES))
      socket.send(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: payload.toString('base64') },
        })
      )
    }
  }

  /** Runs one stretch of the Agent's speech so a Prospect who talks over it can cut it. */
  const speak = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const control = new AbortController()
    speaking = control
    try {
      return await run(control.signal)
    } finally {
      if (speaking === control) {
        speaking = undefined
      }
    }
  }

  const later = (work: () => Promise<void>): void => {
    turns = turns.then(work).catch((error: unknown) => {
      deps.logger.warn('agent media turn failed', {
        callId,
        code: (error as { code?: unknown }).code,
      })
      socket.close(CLOSE_POLICY, 'error')
    })
  }

  const onEvent = (event: StreamEvent): void => {
    if (event.type === 'failed') {
      // Deaf Agent: drop the stream; the provider then ends the Call, which the dialer records.
      deps.logger.warn('agent media speech-to-text failed', { callId, code: event.code })
      socket.close(CLOSE_POLICY, 'speech to text failed')
    } else if (event.type === 'turn') {
      if (speaking !== undefined && !speaking.signal.aborted && event.text.trim() !== '') {
        speaking.abort()
        socket.send(JSON.stringify({ event: 'clear', streamSid }))
      }
      if (event.isFinal && event.endOfTurn && event.text.trim() !== '') {
        later(async () => {
          if (done) {
            return
          }
          const outcome = await speak((bargeIn) =>
            Dial.turn(deps, {
              organizationId,
              callId,
              text: event.text,
              audioSeconds: speechSeconds(event),
              bargeIn,
            })
          )
          if (outcome.kind === 'ended' || outcome.kind === 'handed_off') {
            socket.close(CLOSE_NORMAL, 'agent done')
          }
        })
      }
    }
  }

  /** Waits for the Disclosure to finish and the Call to go live, then starts hearing and speaking. */
  const activate = async (): Promise<void> => {
    let waited = 0
    let call = await deps.calls.get(organizationId, callId)
    while (call?.state === 'disclosing' && waited < LIVE_WAIT_MS && !done) {
      await deps.sleep(LIVE_POLL_MS)
      waited += LIVE_POLL_MS
      call = await deps.calls.get(organizationId, callId)
    }
    if (call?.state !== 'live' || done) {
      socket.close(CLOSE_NORMAL, 'not live')
      return
    }
    if (deps.agentAudio?.attach(callId, write) === false) {
      // A second talk socket for the Call: the first keeps the voice and the opening is not repeated.
      socket.close(CLOSE_POLICY, 'already attached')
      return
    }
    attached = true
    stream = await deps.transcribe.open({
      organizationId,
      callId,
      track: 'prospect',
      encoding: 'pcm_mulaw',
      sampleRate: 8000,
      onEvent,
    })
    if (done) {
      await stream.close()
      return
    }
    later(async () => {
      const opening = await speak((bargeIn) => Dial.open(deps, { organizationId, callId, bargeIn }))
      if (!opening.spoken && !done) {
        socket.close(CLOSE_NORMAL, 'nothing to say')
      }
    })
  }

  const handle = async (data: string | Uint8Array): Promise<void> => {
    let frame: Frame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
    } catch {
      socket.close(CLOSE_POLICY, 'bad frame')
      return
    }
    if (frame.event === 'start' && !started) {
      const call = await deps.calls.get(organizationId, callId)
      if (call?.providerCallSid == null || frame.start?.callSid !== call.providerCallSid) {
        socket.close(CLOSE_POLICY, 'wrong call')
        return
      }
      started = true
      if (typeof frame.start.streamSid !== 'string') {
        socket.close(CLOSE_POLICY, 'bad frame')
        return
      }
      streamSid = frame.start.streamSid
      if (context.talk) {
        await activate()
      }
    } else if (frame.event === 'media' && stream !== undefined) {
      const payload = frame.media?.payload
      if (frame.media?.track !== 'inbound' || typeof payload !== 'string') {
        return
      }
      const chunk = Buffer.from(payload, 'base64')
      if (chunk.length === 0 || chunk.length > MAX_AUDIO_CHUNK_BYTES) {
        return
      }
      try {
        stream.sendAudio(chunk)
      } catch {
        socket.close(CLOSE_NORMAL, 'call over')
      }
    } else if (frame.event === 'stop') {
      socket.close(CLOSE_NORMAL, 'stop')
    }
  }

  return {
    message: (data) => {
      frames = frames
        .then(() => handle(data))
        .catch((error: unknown) => {
          deps.logger.warn('agent media frame failed', {
            callId,
            code: (error as { code?: unknown }).code,
          })
          socket.close(CLOSE_POLICY, 'error')
        })
      return frames
    },
    closed: async () => {
      done = true
      clearTimeout(timer)
      speaking?.abort()
      if (attached) {
        deps.agentAudio?.detach(callId, write)
      }
      await frames
      await turns
      await stream?.close().catch(() => undefined)
    },
  }
}
