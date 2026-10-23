import type { TelephonyEventType } from 'tula-closeline-kit'

/** The longest provider event id the Call log stores. */
export const MAX_PROVIDER_EVENT_ID_LENGTH = 200

/** What a provider callback means for the Call, or why it changes nothing. */
export type MappedCallback =
  | { kind: 'event'; type: TelephonyEventType; eventId: string; at: Date }
  | { kind: 'ignored' }
  | { kind: 'invalid' }

/** Twilio's call status to the event it reports. Pre-answer bookkeeping statuses are absent. */
const STATUS_EVENTS: Readonly<Record<string, TelephonyEventType>> = {
  ringing: 'ringing',
  'in-progress': 'answered',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  // The caller hung up before anyone answered; the Call ended, nobody failed.
  canceled: 'completed',
}

/** Statuses that only say Twilio accepted the request; nothing happened to the Call yet. */
const IGNORED_STATUSES: ReadonlySet<string> = new Set(['queued', 'initiated'])

/** The provider's time for the callback (RFC 2822), or `fallback` when absent or unreadable. */
function occurredAt(form: URLSearchParams, fallback: Date): Date {
  const stamp = form.get('Timestamp')
  const parsed = stamp ? new Date(stamp) : undefined
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback
}

/** The dedup id: built from signed fields only, since the idempotency header is not signed. */
function eventIdOf(composed: string): string | undefined {
  return composed.length <= MAX_PROVIDER_EVENT_ID_LENGTH ? composed : undefined
}

/** Maps a call status callback. Only fields Twilio signs are read, and only to decide and key. */
export function mapStatusCallback(form: URLSearchParams, now: Date): MappedCallback {
  const callSid = form.get('CallSid')
  const callStatus = form.get('CallStatus')
  if (!callSid || !callStatus) {
    return { kind: 'invalid' }
  }
  if (IGNORED_STATUSES.has(callStatus)) {
    return { kind: 'ignored' }
  }
  const type = STATUS_EVENTS[callStatus]
  const eventId = eventIdOf(`${callSid}:${callStatus}:${form.get('SequenceNumber') ?? '0'}`)
  return type && eventId
    ? { kind: 'event', type, eventId, at: occurredAt(form, now) }
    : { kind: 'invalid' }
}

/** Maps a recording status callback; only a finished recording is an event. */
export function mapRecordingCallback(form: URLSearchParams, now: Date): MappedCallback {
  const recordingSid = form.get('RecordingSid')
  const recordingStatus = form.get('RecordingStatus')
  if (!recordingSid || !recordingStatus) {
    return { kind: 'invalid' }
  }
  if (recordingStatus !== 'completed') {
    return { kind: 'ignored' }
  }
  const eventId = eventIdOf(`${recordingSid}:${recordingStatus}`)
  return eventId
    ? { kind: 'event', type: 'recording_ready', eventId, at: occurredAt(form, now) }
    : { kind: 'invalid' }
}
