import { chatRateLimiterBehaviour } from '~/adapters/postgres/chat-limits.behaviour'
import { createMemoryChatRateLimiter } from './chat-limits'

chatRateLimiterBehaviour('memory', () => createMemoryChatRateLimiter())
