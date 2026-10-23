import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { TwilioCallRecord, TwilioStore } from 'tula-closeline-kit'

const hex = () => crypto.randomUUID().replaceAll('-', '')

/** A fresh provider call id. */
export const newProviderCallId = (): string => `CA${hex()}`

/** A fresh Organization id. */
export const newOrganizationId = (): string => formatId('org', crypto.randomUUID())

/** A call record for an Organization, with every field the store keeps filled in. */
export function callRecord(
  organizationId: string,
  overrides: Partial<TwilioCallRecord> = {}
): TwilioCallRecord {
  return {
    organizationId,
    callId: formatId('call', hex()),
    direction: 'outbound',
    disclosure: null,
    bridgedTo: null,
    ringIdentities: [],
    recordingId: null,
    streamId: null,
    ...overrides,
  }
}

/**
 * The behaviour every {@link TwilioStore} must have, run against the memory store and the Postgres
 * one. `make` returns a store over a clean slate; ids are random so suites never collide.
 */
export function twilioStoreBehaviour(name: string, make: () => TwilioStore): void {
  describe(`TwilioStore (${name})`, () => {
    test('a call that was never stored is null', async () => {
      const store = make()
      expect(await store.getCall(newProviderCallId())).toBeNull()
    })

    test('putCall stores a record and replaces it on the next put', async () => {
      const store = make()
      const org = newOrganizationId()
      const id = newProviderCallId()
      const first = callRecord(org)
      await store.putCall(id, first)
      expect(await store.getCall(id)).toEqual(first)

      const second = callRecord(org, {
        callId: first.callId,
        disclosure: { wordingVersion: 2, aiAssisted: true, playedAt: '2026-01-01T00:00:05.000Z' },
        disclosureStarted: true,
        bridgedTo: formatId('mem', hex()),
        ringIdentities: [formatId('mem', hex()), formatId('mem', hex())],
        recordingId: `RE${hex()}`,
        streamId: `MZ${hex()}`,
      })
      await store.putCall(id, second)
      expect(await store.getCall(id)).toEqual(second)
    })

    test('claimCall returns the caller own record when it wins and the standing one when it loses', async () => {
      const store = make()
      const org = newOrganizationId()
      const id = newProviderCallId()
      const mine = callRecord(org)
      expect(await store.claimCall(id, mine)).toEqual(mine)
      const later = callRecord(org)
      expect(await store.claimCall(id, later)).toEqual(mine)
      expect(await store.getCall(id)).toEqual(mine)
    })

    test('one claim wins when many race', async () => {
      const store = make()
      const org = newOrganizationId()
      const id = newProviderCallId()
      const records = Array.from({ length: 8 }, () => callRecord(org))
      const results = await Promise.all(records.map((record) => store.claimCall(id, record)))
      const standing = await store.getCall(id)
      expect(standing).not.toBeNull()
      for (const result of results) {
        expect(result).toEqual(standing as TwilioCallRecord)
      }
    })

    test('withCall passes null for a call that is not there and sees puts made inside it', async () => {
      const store = make()
      const org = newOrganizationId()
      const id = newProviderCallId()
      const record = callRecord(org)
      const seen = await store.withCall(id, async (current) => {
        await store.putCall(id, record)
        return { current, inside: await store.getCall(id) }
      })
      expect(seen.current).toBeNull()
      expect(seen.inside).toEqual(record)
      expect(await store.getCall(id)).toEqual(record)
    })

    test('withCall passes the stored record and lets fn rewrite it', async () => {
      const store = make()
      const org = newOrganizationId()
      const id = newProviderCallId()
      const record = callRecord(org)
      await store.putCall(id, record)
      const next = { ...record, bridgedTo: formatId('mem', hex()) }
      const seen = await store.withCall(id, async (current) => {
        await store.putCall(id, next)
        return current
      })
      expect(seen).toEqual(record)
      expect(await store.getCall(id)).toEqual(next)
    })

    test('withCall runs one call at a time, for a stored call and for an absent one', async () => {
      for (const stored of [true, false]) {
        const store = make()
        const org = newOrganizationId()
        const id = newProviderCallId()
        if (stored) {
          await store.putCall(id, callRecord(org, { streamId: 'n0' }))
        }
        const run = (n: number) =>
          store.withCall(id, async (current) => {
            const count = current?.streamId ? Number(current.streamId.slice(1)) : 0
            await new Promise((resolve) => setTimeout(resolve, 5))
            await store.putCall(id, callRecord(org, { streamId: `n${count + 1}` }))
            return n
          })
        await Promise.all([run(1), run(2), run(3), run(4)])
        expect((await store.getCall(id))?.streamId).toBe(stored ? 'n4' : 'n4')
      }
    })

    test('withCall on one call does not hold up another', async () => {
      const store = make()
      const a = newProviderCallId()
      const b = newProviderCallId()
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const held = store.withCall(a, () => gate)
      const other = await store.withCall(b, async () => 'done')
      expect(other).toBe('done')
      release()
      await held
    })

    test('a Recording is remembered with its provider call', async () => {
      const store = make()
      const org = newOrganizationId()
      const id = newProviderCallId()
      const recordingId = `RE${hex()}`
      await store.putCall(id, callRecord(org))
      expect(await store.getRecording(recordingId)).toBeNull()
      await store.putRecording(recordingId, id)
      expect(await store.getRecording(recordingId)).toEqual({ providerCallId: id })
      // Writing it again changes nothing and does not fail.
      await store.putRecording(recordingId, id)
      expect(await store.getRecording(recordingId)).toEqual({ providerCallId: id })
    })

    test('a placement is remembered per Organization and key', async () => {
      const store = make()
      const org = newOrganizationId()
      const other = newOrganizationId()
      const key = `key-${hex()}`
      const id = newProviderCallId()
      expect(await store.getPlacement(org, key)).toBeNull()
      await store.putPlacement(org, key, { providerCallId: id, fingerprint: 'f1' })
      expect(await store.getPlacement(org, key)).toEqual({ providerCallId: id, fingerprint: 'f1' })
      expect(await store.getPlacement(other, key)).toBeNull()
      expect(await store.getPlacement(org, `${key}-2`)).toBeNull()
    })
  })
}
