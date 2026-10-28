import { afterAll } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresChatRateLimiter } from './chat-limits'
import { chatRateLimiterBehaviour } from './chat-limits.behaviour'

const { db, close } = createDb(integrationUrls().service)

afterAll(close)

chatRateLimiterBehaviour('postgres', () => createPostgresChatRateLimiter(db))
