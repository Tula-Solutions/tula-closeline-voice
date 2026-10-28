import { newCallId, recordingStoreBehaviour } from '~/adapters/postgres/recording-store.behaviour'
import { createMemoryRecordingStore } from './recording-store'

recordingStoreBehaviour('memory', () => ({
  store: createMemoryRecordingStore(),
  newCall: async () => newCallId(),
}))
