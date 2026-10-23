import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { createPostgresTwilioStore } from './twilio-store'
import {
  callRecord,
  newOrganizationId,
  newProviderCallId,
  twilioStoreBehaviour,
} from './twilio-store.behaviour'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
const store = createPostgresTwilioStore(service.db)

afterAll(async () => {
  await service.close()
  await owner.close()
})

twilioStoreBehaviour('postgres', () => createPostgresTwilioStore(service.db))

describe('TwilioStore (postgres) Organization isolation', () => {
  test('a second Organization cannot read, replace or claim over a call', async () => {
    const orgA = newOrganizationId()
    const orgB = newOrganizationId()
    const id = newProviderCallId()
    const recordingId = `RE${crypto.randomUUID().replaceAll('-', '')}`
    const a = callRecord(orgA)
    await store.putCall(id, a)
    await store.putRecording(recordingId, id)

    // B's claim loses, and what B is handed is the standing record that A made, never B's own.
    const claimed = await store.claimCall(id, callRecord(orgB))
    expect(claimed.organizationId).toBe(orgA)
    // B cannot write a record under that provider call id.
    await expect(store.putCall(id, callRecord(orgB))).rejects.toThrow()
    // A is untouched.
    expect(await store.getCall(id)).toEqual(a)
    expect(await store.getRecording(recordingId)).toEqual({ providerCallId: id })
  })

  test('a Recording cannot be attached to a call of another Organization through a call it does not own', async () => {
    const orgA = newOrganizationId()
    const id = newProviderCallId()
    await store.putCall(id, callRecord(orgA))
    const unknownCall = newProviderCallId()
    await expect(
      store.putRecording(`RE${crypto.randomUUID().replaceAll('-', '')}`, unknownCall)
    ).rejects.toThrow()
  })

  test('a placement is invisible to another Organization', async () => {
    const orgA = newOrganizationId()
    const orgB = newOrganizationId()
    await store.putPlacement(orgA, 'shared-key', {
      providerCallId: newProviderCallId(),
      fingerprint: 'f',
    })
    expect(await store.getPlacement(orgB, 'shared-key')).toBeNull()
  })

  test('the service login reads no row without an Organization in scope', async () => {
    const orgA = newOrganizationId()
    const id = newProviderCallId()
    await store.putCall(id, callRecord(orgA))
    const rows = await service.db.execute(
      sql`select 1 from voice.twilio_calls where provider_call_id = ${id}`
    )
    expect(rows.rows.length).toBe(0)
  })

  test('rows carry an expiry for the purge', async () => {
    const orgA = newOrganizationId()
    const id = newProviderCallId()
    await store.putCall(id, callRecord(orgA))
    await store.putPlacement(orgA, 'k', { providerCallId: id, fingerprint: 'f' })
    const rows = await withOrganization(owner.db, orgA, (tx) =>
      tx.execute(sql`select
        (select expires_at > now() from voice.twilio_calls where provider_call_id = ${id}) as call_ok,
        (select expires_at > now() from voice.twilio_placements where organization_id = ${orgA}) as placement_ok`)
    )
    expect(rows.rows[0]).toEqual({ call_ok: true, placement_ok: true })
  })
})
