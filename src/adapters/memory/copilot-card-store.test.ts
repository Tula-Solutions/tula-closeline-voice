import { copilotCardStoreBehaviour } from '~/adapters/postgres/copilot-card-store.behaviour'
import { createMemoryCopilotCardStore } from './copilot-card-store'

copilotCardStoreBehaviour('memory', () => ({
  store: createMemoryCopilotCardStore(),
  newCall: async () => `call_${crypto.randomUUID()}`,
}))
