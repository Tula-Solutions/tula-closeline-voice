import type { OrganizationId, VoiceCall } from 'tula-closeline-contract'
import {
  MAX_SEARCH_TEXT_CHARACTERS,
  MAX_SEARCH_TURNS,
  type SearchTurn,
} from 'tula-closeline-contract'
import type { StreamEvent, TranscribeStream, TurnEvent } from 'tula-closeline-kit'
import type { Container } from '~/container'
import type { Env } from '~/env'
import * as Cards from '~/modules/cards/service'
import type { TranscriptUnavailableReason } from '~/ports/call-store'
import type { TurnTrack } from '~/ports/call-turn-store'
import type { OpenTranscript } from './runtime'

/** What the live Transcript needs from the container. */
export type TranscriptDeps = Pick<
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

const TRACKS: readonly TurnTrack[] = ['rep', 'prospect']
const MAX_TURN_TEXT = 4_000
const MAX_CALL_MS = 43_200_000

/**
 * Where the provider streams a Call's two tracks: this service's media route, never user input.
 * The Organization rides in the path (Twilio drops a query on a Stream URL) because the route is signed by the provider and has no token.
 */
export function mediaUrl(env: Env, callId: string, organizationId: string): string {
  return `${mediaBase(env).replace(/^http/, 'ws')}/media/${organizationId}/${callId}`
}

/** The origin the provider reaches this service on, without a trailing slash. */
export function mediaBase(env: Env): string {
  return (env.WEBHOOK_BASE_URL ?? `http://127.0.0.1:${env.PORT}`).replace(/\/$/, '')
}

const clamp = (ms: number): number => Math.min(Math.max(Math.round(ms), 0), MAX_CALL_MS)

/** Closes streams without letting a failing close hide the reason the caller is closing them. */
async function closeAll(open: OpenTranscript): Promise<void> {
  await Promise.allSettled(Object.values(open.streams).map((stream) => stream.close()))
}

/** The Call, when its Transcript may run: Copilot Disclosure played, Call disclosing or live. */
async function eligible(deps: TranscriptDeps, organizationId: string, callId: VoiceCall['id']) {
  const call = await deps.calls.get(organizationId, callId)
  const playedAt = call?.disclosure.playedAt
  if (
    call === undefined ||
    call.repMembershipId === null ||
    call.providerCallSid === null ||
    !call.disclosure.aiAssisted ||
    playedAt === null ||
    playedAt === undefined ||
    (call.state !== 'disclosing' && call.state !== 'live')
  ) {
    return undefined
  }
  return { ...call, providerCallSid: call.providerCallSid, playedAt }
}

/** Records on the Call that its Transcript stopped; a failed write is logged, never thrown. */
export async function markUnavailable(
  deps: Pick<TranscriptDeps, 'calls' | 'logger'>,
  organizationId: string,
  callId: string,
  reason: TranscriptUnavailableReason
): Promise<void> {
  await deps.calls
    .markTranscriptUnavailable(organizationId, callId as VoiceCall['id'], reason)
    .catch((error: unknown) =>
      deps.logger.warn('transcript.mark_failed', {
        callId,
        code: (error as { code?: unknown }).code,
      })
    )
}

/**
 * Starts the live Transcript of a Rep's Call: forks its two tracks to the media route, where
 * {@link attach} opens the speech-to-text streams once the provider connects. Nothing starts
 * unless the Call is disclosing or live and its stored Disclosure has played and said an AI
 * assists; there is no setting for that (ADR 0003). Idempotent: forking an already forked Call
 * returns the same fork. A failure never touches the Call: the Transcript is marked unavailable
 * and `false` returned.
 */
export async function start(
  deps: TranscriptDeps,
  organizationId: string,
  callId: VoiceCall['id']
): Promise<boolean> {
  const call = await eligible(deps, organizationId, callId)
  if (call === undefined) {
    return false
  }
  try {
    await deps.telephony.forkTracks({
      organizationId: organizationId as OrganizationId,
      providerCallId: call.providerCallSid,
      destinationUrl: mediaUrl(deps.env, callId, organizationId),
    })
    return true
  } catch (error) {
    await markUnavailable(deps, organizationId, callId, 'speech_to_text_failed')
    deps.logger.warn('transcript.start_failed', {
      callId,
      code: (error as { code?: unknown }).code,
    })
    return false
  }
}

/**
 * Opens one speech-to-text stream per track for a Call whose media socket just connected on this
 * instance. Checks the Call again, so a socket for a Call without the Copilot or an unplayed
 * Disclosure gets nothing. Returns false when it refuses, or when this instance already has the
 * Call's streams open. A failure marks the Transcript unavailable and returns false.
 */
export async function attach(
  deps: TranscriptDeps,
  organizationId: string,
  callId: VoiceCall['id']
): Promise<boolean> {
  if (deps.copilot.streams.has(callId)) {
    return false
  }
  const call = await eligible(deps, organizationId, callId)
  if (call === undefined || deps.copilot.streams.has(callId)) {
    return false
  }
  const org = organizationId as OrganizationId
  const open: OpenTranscript = {
    streams: {},
    saving: {},
    window: [],
    searchSeq: 0,
    carding: new Set(),
  }
  // Claimed before the next await, so a second attach for this Call does nothing.
  deps.copilot.streams.set(callId, open)
  try {
    for (const track of TRACKS) {
      // Word times count from the stream's first audio; this puts them on the Call's clock.
      const base = clamp(deps.clock.now().getTime() - Date.parse(call.playedAt))
      let lastSaved = 0
      open.streams[track] = await deps.transcribe.open({
        organizationId: org,
        callId: callId as Parameters<typeof deps.transcribe.open>[0]['callId'],
        track,
        encoding: 'pcm_mulaw',
        sampleRate: 8000,
        onEvent: (event: StreamEvent) => {
          if (event.type === 'failed') {
            void markUnavailable(
              deps,
              organizationId,
              callId,
              event.code === 'streaming_transcribe.unavailable'
                ? 'stream_dropped'
                : 'speech_to_text_failed'
            )
            deps.logger.warn('transcript.unavailable', { callId, code: event.code })
          } else if (event.type === 'turn' && event.isFinal && event.endOfTurn) {
            // A repeated or late final (a reconnect replay) has a sequence already saved.
            if (event.sequence <= lastSaved) {
              return
            }
            lastSaved = event.sequence
            open.saving[track] = (open.saving[track] ?? Promise.resolve()).then(() =>
              save(deps, open, organizationId, callId, track, base, event)
            )
          }
        },
      })
    }
    return true
  } catch (error) {
    await closeAll(open)
    deps.copilot.streams.delete(callId)
    await markUnavailable(deps, organizationId, callId, 'speech_to_text_failed')
    deps.logger.warn('transcript.attach_failed', {
      callId,
      code: (error as { code?: unknown }).code,
    })
    return false
  }
}

/** The most characters of the recent turns one card search reads (the contract's bound). */
const MAX_WINDOW_CHARACTERS = MAX_SEARCH_TEXT_CHARACTERS

/** Adds a saved turn to the recent turns and, for a Prospect turn, starts a card search. */
function remember(
  deps: TranscriptDeps,
  open: OpenTranscript,
  organizationId: string,
  callId: string,
  track: TurnTrack,
  text: string
): void {
  open.window.push({ role: track, text })
  while (open.window.length > MAX_SEARCH_TURNS) {
    open.window.shift()
  }
  // The newest turns are kept: a long one is cut from its start to fit the contract's bound.
  let room = MAX_WINDOW_CHARACTERS
  const fitted: SearchTurn[] = []
  for (const turn of [...open.window].reverse()) {
    if (room <= 0) {
      break
    }
    fitted.unshift({ role: turn.role, text: [...turn.text].slice(-room).join('') })
    room -= [...turn.text].length
  }
  if (track !== 'prospect') {
    return
  }
  const seq = ++open.searchSeq
  const running = Cards.onProspectTurn(
    deps,
    organizationId,
    callId,
    fitted,
    () => open.searchSeq !== seq
  )
  open.carding.add(running)
  void running.finally(() => open.carding.delete(running))
}

/** Stores one final turn, in order per track. A failed write is logged and the stream goes on. */
async function save(
  deps: TranscriptDeps,
  open: OpenTranscript,
  organizationId: string,
  callId: string,
  track: TurnTrack,
  base: number,
  event: TurnEvent
): Promise<void> {
  const text = event.text.trim().slice(0, MAX_TURN_TEXT)
  if (text === '') {
    return
  }
  const startMs = clamp(base + (event.words[0]?.startMs ?? 0))
  const endMs = Math.max(startMs, clamp(base + (event.words.at(-1)?.endMs ?? 0)))
  try {
    await deps.callTurns.append(organizationId, callId, { track, text, startMs, endMs })
    remember(deps, open, organizationId, callId, track, text)
  } catch (error) {
    deps.logger.warn('transcript.save_failed', {
      callId,
      track,
      code: (error as { code?: unknown }).code,
    })
  }
}

/** Sends audio of one track to its stream; a stream that is not open ignores it. */
export function pushAudio(
  deps: Pick<TranscriptDeps, 'copilot'>,
  callId: string,
  track: TurnTrack,
  chunk: Uint8Array
): void {
  const stream: TranscribeStream | undefined = deps.copilot.streams.get(callId)?.streams[track]
  try {
    stream?.sendAudio(chunk)
  } catch {
    // The stream closed or failed between the lookup and the send; its own event says so.
  }
}

/** Whether this instance has the Call's speech-to-text streams open. */
export function isOpen(deps: Pick<TranscriptDeps, 'copilot'>, callId: string): boolean {
  return deps.copilot.streams.has(callId)
}

/** Waits for the turns already heard on a Call to be stored. */
export async function settled(deps: Pick<TranscriptDeps, 'copilot'>, callId: string) {
  const open = deps.copilot.streams.get(callId)
  await Promise.all(Object.values(open?.saving ?? {}))
  await Promise.all([...(open?.carding ?? [])])
}

/** Closes the streams of a Call that ended; the turns already heard are still stored. */
export async function stop(deps: Pick<TranscriptDeps, 'copilot'>, callId: string): Promise<void> {
  const open = deps.copilot.streams.get(callId)
  if (open === undefined) {
    return
  }
  deps.copilot.streams.delete(callId)
  await closeAll(open)
  await Promise.all(Object.values(open.saving))
}
