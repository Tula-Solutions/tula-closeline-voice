import { callTurnStoreBehaviour } from '~/adapters/postgres/call-turn-store.behaviour'
import { createMemoryCallTurnStore } from './call-turn-store'

callTurnStoreBehaviour('memory', () => ({
  store: createMemoryCallTurnStore(),
  newCall: async () => `call_${crypto.randomUUID()}`,
}))
