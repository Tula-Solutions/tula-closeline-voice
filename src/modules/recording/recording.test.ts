import { beforeEach, describe, expect, it } from 'bun:test'
import { formatId, voiceCallEndedEvent } from 'tula-closeline-contract'
import { createMemoryTelephony, type MemoryTelephony } from 'tula-closeline-kit/testing'
import { LOCAL_INTERNAL_API_TOKEN } from '~/env'
import { eventIdOf, finish, phoneHash } from '~/modules/recording/finish'
import { enqueueFinish, runJobs } from '~/modules/recording/jobs'
import { purgeRecordings } from '~/modules/recording/purge'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

const PROSPECT = '+14155550100'
let n = 0
const nextKey = () => `recording-key-${String(++n).padStart(6, '0')}`

let t: TestApp
let telephony: MemoryTelephony
let organizationId: ReturnType<typeof newOrganizationId>
let admin: TestIdentity
let rep: TestIdentity
let otherRep: TestIdentity

const membershipFor = (who: TestIdentity): string => {
  const id = formatId('mem', crypto.randomUUID())
  t.deps.directory.addMembership(who.organizationId, who.userId, id)
  t.deps.directory.addRep(who.organizationId, id)
  return id
}

async function lineFor(membershipId: string): Promise<void> {
  const bought = await t.call(admin, 'POST', '/lines', { method: 'buy', country: 'US' })
  const id = (bought.body as { id: string }).id
  await t.call(admin, 'PUT', `/lines/${id}/assignment`, { kind: 'rep', membershipId })
}

beforeEach(async () => {
  telephony = createMemoryTelephony()
  t = await createTestApp({ telephony })
  organizationId = newOrganizationId()
  admin = identityOf('admin', organizationId)
  rep = identityOf('rep', organizationId)
  otherRep = identityOf('rep', organizationId)
  await lineFor(membershipFor(rep))
  await lineFor(membershipFor(otherRep))
  telephony.script(PROSPECT, { kind: 'answers' })
})

/** Places a Call as `who`, hangs up, ends it and returns its id with the provider's recording id. */
async function endedCall(who: TestIdentity = rep) {
  const response = await t.app.request('/v1/calls', {
    method: 'POST',
    headers: {
      ...(await t.bearer(who)),
      'content-type': 'application/json',
      'idempotency-key': nextKey(),
    },
    body: JSON.stringify({ to: PROSPECT }),
  })
  const callId = ((await response.json()) as { call: { id: string } }).call.id
  const view = telephony.calls(who.organizationId).at(-1)
  if (view?.recordingId == null) {
    throw new Error('the Call has no Recording')
  }
  telephony.prospectHangsUp(who.organizationId, view.providerCallId)
  await t.deps.calls.transition(who.organizationId, callId as never, {
    to: 'ended',
    at: new Date('2026-01-01T00:01:00Z'),
    endedBy: 'prospect',
  })
  return { callId: callId as never, recordingSid: view.recordingId }
}

const run = () => runJobs(t.deps, { shouldStop: () => false })

async function drainEvents() {
  const out = []
  for (;;) {
    const got = await t.deps.events.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: 1,
      waitSeconds: 0,
    })
    if (got.length === 0) {
      return out
    }
    for (const delivery of got) {
      if (delivery.kind === 'message') {
        out.push(delivery.envelope)
        await t.deps.events.acknowledge(delivery.receipt)
      }
    }
  }
}

const internalGet = (callId: string, org: string | null, secret: string | null) =>
  t.app.request(`/internal/v1/calls/${callId}/recording`, {
    headers: {
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
      ...(org === null ? {} : { 'x-organization-id': org }),
    },
  })

describe('finishing a Call', () => {
  it('copies the Recording and publishes one valid event, whatever the deliveries', async () => {
    const { callId, recordingSid } = await endedCall()
    await enqueueFinish(t.deps.jobs, organizationId, callId, recordingSid)
    await enqueueFinish(t.deps.jobs, organizationId, callId, recordingSid)
    expect(await run()).toBe(3) // the two above and the one the ending queued

    const row = await t.deps.recordings.get(organizationId, callId)
    expect(row?.state).toBe('stored')
    // The provider sends WAV, so the key and type say WAV.
    const info = await t.deps.storage.head(organizationId, row?.storageKey ?? '')
    expect(info?.contentType).toBe('audio/wav')
    expect(row?.storageKey.endsWith('.wav')).toBe(true)
    const events = await drainEvents()
    expect(events.map((e) => e.id)).toEqual([eventIdOf(callId)])
    const payload = voiceCallEndedEvent.schema.shape.data.parse(events[0]?.payload)
    expect(payload.recordingKey).toBe(row?.storageKey ?? null)
    expect(payload.outcome).toBe('completed')
    expect(telephony.recordingCount()).toBe(0)
  })

  it('publishes the event with no recording key when no Recording started', async () => {
    const response = await t.call(admin, 'GET', '/calls')
    expect(response.status).toBe(200)
    const callId = formatId('call', crypto.randomUUID()) as never
    await t.deps.calls.insert(organizationId, {
      id: callId,
      lineId: formatId('line', crypto.randomUUID()),
      repMembershipId: null,
      prospectId: null,
      prospectNumber: PROSPECT,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as never)
    await t.deps.calls.transition(organizationId, callId, {
      to: 'missed',
      at: new Date('2026-01-01T00:00:30Z'),
    })
    expect(await run()).toBe(1)
    const events = await drainEvents()
    const payload = voiceCallEndedEvent.schema.shape.data.parse(events[0]?.payload)
    expect(payload.outcome).toBe('missed')
    expect(payload.recordingKey).toBeNull()
  })

  it('does not finish a Call that has not ended, and keeps its job', async () => {
    const { callId } = await endedCall()
    const live = formatId('call', crypto.randomUUID()) as never
    await t.deps.calls.insert(organizationId, {
      id: live,
      lineId: formatId('line', crypto.randomUUID()),
      repMembershipId: null,
      prospectId: null,
      prospectNumber: PROSPECT,
      createdAt: new Date(),
    } as never)
    expect(await finish(t.deps, organizationId, { callId: live, recordingSid: null })).toBe(false)
    expect(callId).toBeDefined()
  })

  it('leaves a failing job on the queue and logs no more than the Call and error name', async () => {
    const { callId } = await endedCall()
    await enqueueFinish(t.deps.jobs, organizationId, callId, 'memrec-unknown')
    await run()
    expect(t.deps.jobs.depth().inFlight).toBeGreaterThan(0)
    expect(t.deps.logLines.join('\n')).toContain('recording.job_failed')
    expect(t.deps.logLines.join('\n')).not.toContain(PROSPECT)
  })

  it('hashes the number per Organization without keeping it', () => {
    const a = phoneHash('k'.repeat(32), 'org_a', PROSPECT)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(phoneHash('k'.repeat(32), 'org_b', PROSPECT))
  })
})

describe('the internal route', () => {
  it('rejects a missing or wrong secret', async () => {
    const { callId, recordingSid } = await endedCall()
    await enqueueFinish(t.deps.jobs, organizationId, callId, recordingSid)
    await run()
    expect((await internalGet(callId, organizationId, null)).status).toBe(401)
    expect((await internalGet(callId, organizationId, 'wrong-secret-0123456789')).status).toBe(401)
    const ok = await internalGet(callId, organizationId, LOCAL_INTERNAL_API_TOKEN)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('audio/wav')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect((await ok.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('never serves another Organization its Recording', async () => {
    const { callId, recordingSid } = await endedCall()
    await enqueueFinish(t.deps.jobs, organizationId, callId, recordingSid)
    await run()
    const response = await internalGet(callId, newOrganizationId(), LOCAL_INTERNAL_API_TOKEN)
    expect(response.status).toBe(404)
  })
})

describe('playback and deletion', () => {
  async function stored(who: TestIdentity = rep) {
    const made = await endedCall(who)
    await enqueueFinish(t.deps.jobs, organizationId, made.callId, made.recordingSid)
    await run()
    return made.callId as string
  }

  it('signs a short-lived URL for the caller’s own Call only', async () => {
    const callId = await stored(rep)
    const mine = await t.call(rep, 'GET', `/calls/${callId}/recording`)
    expect(mine.status).toBe(200)
    const body = mine.body as { url: string; expiresAt: string; channels: number }
    expect(Date.parse(body.expiresAt) - t.deps.clock.now().getTime()).toBe(300_000)
    expect(await t.deps.storage.resolvePresigned(body.url)).toBeDefined()
    expect((await t.call(otherRep, 'GET', `/calls/${callId}/recording`)).status).toBe(404)
    expect((await t.call(admin, 'GET', `/calls/${callId}/recording`)).status).toBe(200)
  })

  it('stops resolving the URL once it has expired', async () => {
    const callId = await stored()
    const body = (await t.call(rep, 'GET', `/calls/${callId}/recording`)).body as { url: string }
    t.deps.clock.advance('301s')
    expect(await t.deps.storage.resolvePresigned(body.url)).toBeUndefined()
  })

  it('lets only an Owner or Admin delete, answers repeats alike, and purges after the delay', async () => {
    const callId = await stored()
    expect((await t.call(rep, 'DELETE', `/calls/${callId}/recording`)).status).toBe(403)
    const first = await t.call(admin, 'DELETE', `/calls/${callId}/recording`)
    const second = await t.call(admin, 'DELETE', `/calls/${callId}/recording`)
    expect(first.status).toBe(second.status)
    expect((first.body as { recordingState: string }).recordingState).toBe('deleted')
    expect((await t.call(rep, 'GET', `/calls/${callId}/recording`)).status).toBe(404)

    const key = (await t.deps.recordings.get(organizationId, callId as never))?.storageKey ?? ''
    const options = { maxOrganizations: 10, shouldStop: () => false }
    expect(await purgeRecordings(t.deps, options)).toBe(0)
    expect(await t.deps.storage.head(organizationId, key)).toBeDefined()
    t.deps.clock.advance('25h')
    expect(await purgeRecordings(t.deps, options)).toBe(1)
    expect(await t.deps.storage.head(organizationId, key)).toBeUndefined()
    expect(await purgeRecordings(t.deps, options)).toBe(0)
    expect((await t.call(admin, 'DELETE', `/calls/${callId}/recording`)).status).toBe(first.status)
  })
})
