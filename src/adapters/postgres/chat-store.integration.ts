import { afterAll } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresChatStore } from './chat-store'
import { chatStoreBehaviour } from './chat-store.behaviour'

const { db, close } = createDb(integrationUrls().service)

afterAll(close)

chatStoreBehaviour('postgres', () => createPostgresChatStore(db))
