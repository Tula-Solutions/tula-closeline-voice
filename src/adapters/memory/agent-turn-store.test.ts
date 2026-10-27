import { agentTurnStoreBehaviour } from '~/adapters/postgres/agent-turn-store.behaviour'
import { createMemoryAgentTurnStore } from './agent-turn-store'

agentTurnStoreBehaviour('memory', () => createMemoryAgentTurnStore())
