import type { VoiceCall } from 'tula-closeline-contract'

/** Where a Recording is: being copied, in Region storage, or deleted (its file purged later). */
export type StoredRecordingState = 'storing' | 'stored' | 'deleted'

/** One Call's Recording as voice keeps it; the file itself is in the object store. */
export type StoredRecording = {
  callId: VoiceCall['id']
  /** The object-store key, the same for every attempt at this Call. */
  storageKey: string
  sizeBytes: number | null
  state: StoredRecordingState
  /** When the file may be removed; `null` once it has been, or while the Recording is kept. */
  purgeDueAt: Date | null
}

/**
 * Where an Organization's Recording rows are kept. Every method takes the Organization first and
 * reaches that Organization's rows only: another Organization's Recording is `undefined`.
 */
export type RecordingStore = {
  /** Creates the Recording `storing` once per Call; a repeat returns the row the first made. */
  begin: (organizationId: string, callId: VoiceCall['id'], at: Date) => Promise<StoredRecording>
  /** Moves `storing` to `stored`; `true` only for the one caller that did it. */
  markStored: (
    organizationId: string,
    callId: VoiceCall['id'],
    stored: { sizeBytes: number; at: Date }
  ) => Promise<boolean>
  /** The Recording of a Call, or `undefined` when it has none. */
  get: (organizationId: string, callId: VoiceCall['id']) => Promise<StoredRecording | undefined>
  /** The state of each named Call's Recording; a Call with none is left out. */
  states: (
    organizationId: string,
    callIds: readonly VoiceCall['id'][]
  ) => Promise<Map<string, StoredRecordingState>>
  /** Marks the Recording deleted and schedules its file for removal; a repeat changes nothing. */
  markDeleted: (
    organizationId: string,
    callId: VoiceCall['id'],
    deletion: { at: Date; purgeDueAt: Date }
  ) => Promise<StoredRecording | undefined>
  /** Up to `limit` Organization ids, ascending and after `after`, with a file due for removal. */
  organizationsWithDue: (before: Date, after: string | null, limit: number) => Promise<string[]>
  /** Up to `limit` deleted Recordings of the Organization whose file is due for removal. */
  due: (organizationId: string, before: Date, limit: number) => Promise<StoredRecording[]>
  /** Records that the file has been removed, so the Recording is no longer due. */
  finishPurge: (organizationId: string, callId: VoiceCall['id']) => Promise<void>
}

/** The object-store key of a Call's Recording, one per Call whatever the number of attempts. */
export const recordingKeyOf = (callId: VoiceCall['id']): string => `recordings/${callId}.wav`

/** The media type of every stored Recording; the provider is asked for WAV. */
// shortcut: one fixed type and the `.wav` key; the table has no content-type column, add one before a second format.
export const RECORDING_MEDIA_TYPE = 'audio/wav'
