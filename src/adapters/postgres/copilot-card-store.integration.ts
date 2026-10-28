import { afterAll } from 'bun:test'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresCallStore } from './call-store'
import { createPostgresCopilotCardStore } from './copilot-card-store'
import { copilotCardStoreBehaviour } from './copilot-card-store.behaviour'
import { createPostgresLineStore } from './line-store'

const { db, close } = createDb(integrationUrls().service)
const lines = createPostgresLineStore(db)
const calls = createPostgresCallStore(db)

afterAll(close)

copilotCardStoreBehaviour('postgres', () => ({
  store: createPostgresCopilotCardStore(db),
  // A turn refers to a Call, which refers to a Line.
  newCall: async (organization) => {
    const org = organization as OrganizationId
    const at = new Date('2026-01-01T00:00:00.000Z')
    const line = await lines.insert(org, {
      id: formatId('line', crypto.randomUUID()),
      number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
      country: 'US',
      label: null,
      state: 'active',
      providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
      createdAt: at,
    })
    const call = await calls.insert(org, {
      id: formatId('call', crypto.randomUUID()),
      lineId: line.id,
      repMembershipId: formatId('mem', crypto.randomUUID()),
      prospectId: null,
      prospectNumber: '+14155550100',
      createdAt: at,
    })
    return call.id
  },
}))
