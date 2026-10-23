import type { CallEventStore, ProviderCallbackRecord } from '~/ports/call-event-store'

/** The in-memory log plus what a test uses to fill it and read it back. */
export type MemoryCallEventStore = CallEventStore & {
  /** Declares a Call of an Organization, so callbacks for it are accepted. */
  addCall: (organizationId: string, callId: string) => void
  /** Every callback recorded, in order. */
  recorded: ProviderCallbackRecord[]
}

/** A call event log held in memory, for tests and local runs. */
export function createMemoryCallEventStore(): MemoryCallEventStore {
  const calls = new Set<string>()
  const seen = new Set<string>()
  const recorded: ProviderCallbackRecord[] = []
  return {
    recorded,
    addCall: (organizationId, callId) => void calls.add(`${organizationId}/${callId}`),
    recordProviderCallback: async (record) => {
      if (!calls.has(`${record.organizationId}/${record.callId}`)) {
        return 'unknown_call'
      }
      const key = `${record.organizationId}/${record.providerEventId}`
      if (seen.has(key)) {
        return 'duplicate'
      }
      seen.add(key)
      recorded.push(record)
      return 'recorded'
    },
  }
}
