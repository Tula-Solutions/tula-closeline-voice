import { afterAll } from 'bun:test'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresCallStore } from './call-store'
import { createPostgresLineStore } from './line-store'
import { createPostgresRecordingStore } from './recording-store'
import { recordingStoreBehaviour } from './recording-store.behaviour'

const { db, close } = createDb(integrationUrls().service)
const calls = createPostgresCallStore(db)
const lines = createPostgresLineStore(db)

afterAll(close)

/** A Recording needs its Call row: this inserts a Line and a Call for the Organization. */
async function newCall(organizationId: string) {
  const org = organizationId as OrganizationId
  const line = await lines.insert(org, {
    id: formatId('line', crypto.randomUUID()),
    number: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    country: 'US',
    label: null,
    state: 'active',
    providerSid: `PN${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: new Date(),
  })
  const call = await calls.insert(org, {
    id: formatId('call', crypto.randomUUID()),
    lineId: line.id,
    repMembershipId: formatId('mem', crypto.randomUUID()),
    prospectId: null,
    prospectNumber: '+14155550100',
    createdAt: new Date(),
  })
  return call.id
}

recordingStoreBehaviour('postgres', () => ({
  store: createPostgresRecordingStore(db),
  newCall,
}))
