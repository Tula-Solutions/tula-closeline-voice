import {
  ERRORS,
  type OrganizationId,
  type RecordingPlayback,
  SALES_HISTORY_ERRORS,
  VOICE_ADMIN_ROLES,
  VOICE_ERRORS,
  type VoiceCall,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Calls from '~/modules/call/service'
import type { Caller } from '~/modules/caller'
import { isFinal } from '~/modules/recording/finish'
import { RECORDING_MEDIA_TYPE, type StoredRecording } from '~/ports/recording-store'

/** What the Recording service needs from the container. */
export type RecordingDeps = Pick<Container, 'recordings' | 'storage' | 'clock'> & Calls.CallDeps

/** How long a playback URL works; the portal asks again when it runs out. */
export const PLAYBACK_URL_SECONDS = 300

/** A Recording that is in storage, or the error that says why it is not. */
function readable(row: StoredRecording | undefined): StoredRecording {
  if (row === undefined || row.state === 'deleted') {
    throw domainError(VOICE_ERRORS['recording.not_found'])
  }
  if (row.state !== 'stored') {
    throw domainError(VOICE_ERRORS['recording.not_ready'])
  }
  return row
}

/**
 * A short-lived URL to play the Call's Recording, for a caller who may see the Call (a Rep sees
 * only their own, a Manager their Team's, an Owner or Admin all). The URL is a bearer credential:
 * it is returned once and never logged or stored.
 */
export async function playback(
  deps: RecordingDeps,
  caller: Caller,
  callId: VoiceCall['id']
): Promise<RecordingPlayback> {
  const call = await Calls.get(deps, caller, callId)
  const row = readable(await deps.recordings.get(caller.organizationId, callId))
  const url = await deps.storage.presignGet(caller.organizationId, row.storageKey, {
    expiresInSeconds: PLAYBACK_URL_SECONDS,
  })
  return {
    callId,
    url,
    expiresAt: new Date(deps.clock.now().getTime() + PLAYBACK_URL_SECONDS * 1000).toISOString(),
    mediaType: RECORDING_MEDIA_TYPE,
    channels: 2,
    durationSeconds: call.durationSeconds ?? 0,
  }
}

/**
 * Deletes the Call's Recording at an Owner's or Admin's request: it stops being playable now and
 * its file is removed after the purge delay. Asking again changes nothing and answers the same.
 */
export async function remove(
  deps: RecordingDeps,
  caller: Caller,
  callId: VoiceCall['id']
): Promise<VoiceCall> {
  if (!(VOICE_ADMIN_ROLES as readonly string[]).includes(caller.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  const call = await Calls.get(deps, caller, callId)
  if (!isFinal(call.state)) {
    throw domainError(VOICE_ERRORS['call.not_ended'])
  }
  const now = deps.clock.now()
  const row = await deps.recordings.markDeleted(caller.organizationId, callId, {
    at: now,
    purgeDueAt: new Date(now.getTime() + deps.env.RECORDING_PURGE_DELAY_MS),
  })
  if (row === undefined) {
    throw domainError(VOICE_ERRORS['recording.not_found'])
  }
  return Calls.get(deps, caller, callId)
}

/** The file of an Organization's Recording for a trusted service; any other Organization's is not found. */
export async function open(
  deps: Pick<Container, 'calls' | 'recordings' | 'storage'>,
  organizationId: OrganizationId,
  callId: VoiceCall['id']
) {
  if ((await deps.calls.get(organizationId, callId)) === undefined) {
    throw domainError(SALES_HISTORY_ERRORS['call.not_found'])
  }
  const row = readable(await deps.recordings.get(organizationId, callId))
  const object = await deps.storage.getStream(organizationId, row.storageKey)
  if (object === undefined) {
    throw domainError(VOICE_ERRORS['recording.not_found'])
  }
  return object
}
