import type { OrganizationId, VoiceCall } from 'tula-closeline-contract'
import type { StreamEvent, TranscribeStream, TurnEvent } from 'tula-closeline-kit'
import type { Container } from '~/container'
import type { Env } from '~/env'
import type { TurnTrack } from '~/ports/call-turn-store'
import { markUnavailable, type OpenTranscript } from './runtime'

/** What the live Transcript needs from the container. */
export type TranscriptDeps = Pick<
  Container,
  'calls' | 'callTurns' | 'telephony' | 'transcribe' | 'copilot' | 'clock' | 'logger' | 'env'
>

const TRACKS: readonly TurnTrack[] = ['rep', 'prospect']
const MAX_TURN_TEXT = 4_000
const MAX_CALL_MS = 43_200_000

/** Where the provider streams a Call's two tracks: this service's media route, never user input. */
function mediaUrl(env: Env, callId: string): string {
  const base = env.WEBHOOK_BASE_URL ?? `http://127.0.0.1:${env.PORT}`
  return `${base.replace(/\/$/, '').replace(/^http/, 'ws')}/media/${callId}`
}

const clamp = (ms: number): number => Math.min(Math.max(Math.round(ms), 0), MAX_CALL_MS)

/** Closes streams without letting a failing close hide the reason the caller is closing them. */
async function closeAll(open: OpenTranscript): Promise<void> {
  await Promise.allSettled(Object.values(open.streams).map((stream) => stream.close()))
}

/**
 * Starts the live Transcript of a Rep's Call: forks its two tracks and opens one speech-to-text
 * stream for each. Nothing opens unless the Call is disclosing or live and its stored Disclosure
 * has played and said an AI assists; there is no setting for that (ADR 0003). Idempotent: a Call
 * whose streams are open is left as it is. A failure never touches the Call: the Transcript is
 * marked unavailable and `false` returned.
 */
export async function start(
  deps: TranscriptDeps,
  organizationId: string,
  callId: VoiceCall['id']
): Promise<boolean> {
  if (deps.copilot.streams.has(callId)) {
    return true
  }
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
    return false
  }
  const org = organizationId as OrganizationId
  const open: OpenTranscript = { streams: {}, saving: {} }
  // Claimed before any await, so a second start for this Call does nothing.
  deps.copilot.streams.set(callId, open)
  try {
    await deps.telephony.forkTracks({
      organizationId: org,
      providerCallId: call.providerCallSid,
      destinationUrl: mediaUrl(deps.env, callId),
    })
    for (const track of TRACKS) {
      // Word times count from the stream's first audio; this puts them on the Call's clock.
      const base = clamp(deps.clock.now().getTime() - Date.parse(playedAt))
      let lastSaved = 0
      open.streams[track] = await deps.transcribe.open({
        organizationId: org,
        callId: callId as Parameters<typeof deps.transcribe.open>[0]['callId'],
        track,
        encoding: 'pcm_mulaw',
        sampleRate: 8000,
        onEvent: (event: StreamEvent) => {
          if (event.type === 'failed') {
            markUnavailable(
              deps.copilot,
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
              save(deps, organizationId, callId, track, base, event)
            )
          }
        },
      })
    }
    return true
  } catch (error) {
    await closeAll(open)
    deps.copilot.streams.delete(callId)
    markUnavailable(deps.copilot, callId, 'speech_to_text_failed')
    deps.logger.warn('transcript.start_failed', {
      callId,
      code: (error as { code?: unknown }).code,
    })
    return false
  }
}

/** Stores one final turn, in order per track. A failed write is logged and the stream goes on. */
async function save(
  deps: TranscriptDeps,
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

/** Waits for the turns already heard on a Call to be stored. */
export async function settled(deps: Pick<TranscriptDeps, 'copilot'>, callId: string) {
  await Promise.all(Object.values(deps.copilot.streams.get(callId)?.saving ?? {}))
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
