import { chatStoreBehaviour } from '~/adapters/postgres/chat-store.behaviour'
import { createMemoryChatStore } from './chat-store'

chatStoreBehaviour('memory', () => createMemoryChatStore())
