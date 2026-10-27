import { afterAll } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresAgentTurnStore } from './agent-turn-store'
import { agentTurnStoreBehaviour } from './agent-turn-store.behaviour'

const { db, close } = createDb(integrationUrls().service)

afterAll(close)

agentTurnStoreBehaviour('postgres', () => createPostgresAgentTurnStore(db))
