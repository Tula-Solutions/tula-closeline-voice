import { agentCallStoreBehaviour } from '~/adapters/postgres/agent-call-store.behaviour'
import { createMemoryAgentCallStore } from './agent-call-store'

agentCallStoreBehaviour('memory', () => {
  const store = createMemoryAgentCallStore()
  return {
    store,
    newLine: async () => `line_${crypto.randomUUID().replaceAll('-', '')}` as never,
    dial: async (org, id, dial) =>
      store.recordDial(org, id, {
        numberHash: dial.hash,
        at: dial.at,
        lineId: dial.lineId,
        ...(dial.open === undefined ? {} : { open: dial.open }),
        ...(dial.answered === undefined ? {} : { answered: dial.answered }),
      }),
  }
})
