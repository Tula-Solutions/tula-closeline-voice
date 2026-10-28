import {
  decodeCursor,
  ERRORS,
  encodeCursor,
  type getTranscriptQuerySchema,
  type TranscriptPage,
  transcriptCursorSchema,
  type VoiceCall,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import { domainError } from '~/http/domain-error'
import * as Calls from '~/modules/call/service'
import type { Caller } from '~/modules/caller'
import { MAX_TURN_PAGE, type TurnCursor } from '~/ports/call-turn-store'

/** One page of a Call's Transcript, in time order, for a caller who may see the Call. */
export async function page(
  deps: Calls.CallDeps,
  caller: Caller,
  callId: VoiceCall['id'],
  query: z.infer<typeof getTranscriptQuerySchema>
): Promise<TranscriptPage> {
  const call = await Calls.get(deps, caller, callId)
  const start =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, transcriptCursorSchema)
  if (query.cursor !== undefined && start === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const state = call.recordingState === 'deleted' ? 'deleted' : call.transcriptState
  if (state !== 'ready') {
    return { callId, state, items: [], nextCursor: null }
  }
  // shortcut: the store pages by track, so reach `index` by reading from the start. Bounded by the
  // longest Call; upgrade to a keyset on (startMs, track, sequence) if Transcripts get long.
  const skip = start?.index ?? 0
  const want = skip + query.limit + 1
  const cursor: TurnCursor = { rep: 0, prospect: 0 }
  const turns = []
  while (turns.length < want) {
    const batch = await deps.callTurns.list(caller.organizationId, callId, cursor, MAX_TURN_PAGE)
    for (const turn of batch) {
      cursor[turn.track] = turn.sequence
      turns.push(turn)
    }
    if (batch.length < MAX_TURN_PAGE) {
      break
    }
  }
  const items = turns.slice(skip, skip + query.limit).map((t) => ({
    speaker: t.track,
    startMs: t.startMs,
    endMs: t.endMs,
    text: t.text,
  }))
  const more = turns.length > skip + query.limit
  return {
    callId,
    state,
    items,
    nextCursor: more ? encodeCursor({ index: skip + query.limit }) : null,
  }
}
