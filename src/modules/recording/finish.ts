import type { OrganizationId, VoiceCallState } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { eventRegistry } from '~/modules/recording/messages'
import type { StoredCall } from '~/ports/call-store'
import { RECORDING_MEDIA_TYPE } from '~/ports/recording-store'

/** What finishing a Call's Recording needs from the container. */
export type FinishDeps = Pick<
  Container,
  'calls' | 'recordings' | 'storage' | 'telephony' | 'events' | 'clock' | 'env'
>

const FINAL: ReadonlySet<VoiceCallState> = new Set(['ended', 'failed', 'missed'])

/** Whether a Call has reached a state it cannot leave. */
export const isFinal = (state: VoiceCallState): boolean => FINAL.has(state)

const OUTCOMES = { ended: 'completed', failed: 'failed', missed: 'missed' } as const

const hmac = (key: string | Uint8Array, text: string): Buffer =>
  new Bun.CryptoHasher('sha256', key).update(text).digest() as Buffer

/** The stable hash of a Prospect's number for one Organization; the number itself never leaves. */
export function phoneHash(key: string, organizationId: string, number: string): string {
  const organizationKey = hmac(key, `organization:${organizationId}`)
  return hmac(organizationKey, `phone:${number}`).toString('hex')
}

/** The id of a Call's one `voice.call.ended` event: the same on every delivery, so consumers drop repeats. */
export const eventIdOf = (callId: string): string =>
  `evt_${new Bun.CryptoHasher('sha256').update(`voice.call.ended:${callId}`).digest('hex').slice(0, 32)}`

/** Publishes the Call's `voice.call.ended` event; calling it again publishes the same event id. */
async function publish(
  deps: FinishDeps,
  organizationId: string,
  call: StoredCall,
  recordingKey: string | null
): Promise<void> {
  const outcome = OUTCOMES[call.state as keyof typeof OUTCOMES]
  const key = deps.env.PHONE_HASH_KEY
  if (outcome === undefined || key === undefined || call.endedAt === null) {
    throw new TypeError('a Call is finished only in a final state with a hash key')
  }
  await deps.events.publish(
    eventRegistry.create({
      type: 'voice.call.ended',
      id: eventIdOf(call.id),
      traceId: call.id,
      organizationId,
      occurredAt: new Date(call.endedAt),
      payload: {
        callId: call.id,
        direction: call.direction,
        lineId: call.lineId,
        repMembershipId: call.repMembershipId,
        prospectId: call.prospectId,
        prospectPhoneHash: phoneHash(key, organizationId, call.prospectNumber),
        outcome,
        failureReason: call.failureReason,
        startedAt: call.createdAt,
        answeredAt: call.answeredAt,
        endedAt: call.endedAt,
        durationSeconds: call.durationSeconds,
        disclosureWordingVersion: call.disclosure.wordingVersion,
        recordingKey,
        // shortcut: the event goes out when the Recording is copied, so a Deal linked at wrap-up
        // after that is missed here; send `dealId` in a second event when a consumer needs it.
        dealId: call.dealId,
      },
    })
  )
}

/**
 * Finishes one Call: copies its Recording into our store and publishes `voice.call.ended`. Safe to
 * run any number of times for the same job: the Recording row and the object are written once and
 * the event always carries the same id. Returns `false` when it cannot finish yet (the Call has
 * not ended, or the Recording is not ready), so the job stays on the queue.
 */
export async function finish(
  deps: FinishDeps,
  organizationId: OrganizationId,
  job: { callId: StoredCall['id']; recordingSid: string | null }
): Promise<boolean> {
  const call = await deps.calls.get(organizationId, job.callId)
  if (call === undefined) {
    return true
  }
  if (!isFinal(call.state)) {
    return false
  }
  const log = await deps.calls.events(organizationId, call.id)
  if (!log.some((entry) => entry.kind === 'recording_started')) {
    await publish(deps, organizationId, call, null)
    return true
  }
  if (job.recordingSid === null) {
    // The Call ended; the Recording's own job publishes once the copy exists.
    return true
  }
  const row = await deps.recordings.begin(organizationId, call.id, deps.clock.now())
  const recordingId = job.recordingSid
  if (row.state === 'storing') {
    const fetched = await deps.telephony.fetchRecording({ organizationId, recordingId })
    const put = await deps.storage.putStream(organizationId, row.storageKey, fetched.body, {
      maxBytes: deps.env.RECORDING_MAX_BYTES,
      contentType: RECORDING_MEDIA_TYPE,
    })
    // The event goes out before the row says `stored`: a crash between the two repeats both, and
    // the event id is the same, so a consumer sees one event.
    await publish(deps, organizationId, call, row.storageKey)
    const won = await deps.recordings.markStored(organizationId, call.id, {
      sizeBytes: put.size,
      at: deps.clock.now(),
    })
    if (!won && (await deps.recordings.get(organizationId, call.id))?.state === 'deleted') {
      // Deleted while it was being copied: the purge will not find an object it never listed.
      await deps.storage.delete(organizationId, row.storageKey)
    }
  } else if (row.state === 'deleted') {
    // Deleted before the event went out (a stored row's event is already out: it precedes `stored`).
    await publish(deps, organizationId, call, null)
  }
  // The provider's copy is no longer needed (and its deletion is idempotent).
  await deps.telephony.deleteRecording({ organizationId, recordingId })
  return true
}
