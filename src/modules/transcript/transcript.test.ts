import { beforeEach, describe, expect, it } from 'bun:test'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { TELEPHONY_ERROR_CODES } from 'tula-closeline-kit'
import { createMemoryTelephony, type MemoryTelephony } from 'tula-closeline-kit/testing'
import * as Calls from '~/modules/call/service'
import * as Transcript from '~/modules/transcript/service'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

const PROSPECT = '+14155550100'
let n = 0
let t: TestApp
let telephony: MemoryTelephony
let org: OrganizationId
let admin: TestIdentity
let rep: TestIdentity

type CallBody = { id: string; state: string }

beforeEach(async () => {
  telephony = createMemoryTelephony()
  t = await createTestApp({ telephony })
  org = newOrganizationId()
  admin = identityOf('admin', org)
  rep = identityOf('rep', org)
  const membership = formatId('mem', crypto.randomUUID())
  t.deps.directory.addMembership(org, rep.userId, membership)
  t.deps.directory.addRep(org, membership)
  const bought = await t.call(admin, 'POST', '/lines', { method: 'buy', country: 'US' })
  const lineId = (bought.body as { id: string }).id
  await t.call(admin, 'PUT', `/lines/${lineId}/assignment`, {
    kind: 'rep',
    membershipId: membership,
  })
  telephony.script(PROSPECT, { kind: 'answers' })
})

async function place(body: Record<string, unknown>) {
  const response = await t.app.request('/v1/calls', {
    method: 'POST',
    headers: {
      ...(await t.bearer(rep)),
      'content-type': 'application/json',
      'idempotency-key': `copilot-key-${String(++n).padStart(8, '0')}`,
    },
    body: JSON.stringify(body),
  })
  const parsed = (await response.json()) as { call?: CallBody }
  return { status: response.status, call: parsed.call }
}

/** Sends enough audio on a track for every scripted turn to be heard. */
function speak(callId: string, track: 'rep' | 'prospect') {
  Transcript.pushAudio(t.deps, callId, track, new Uint8Array(4_000))
}

type Script = Partial<Record<'rep' | 'prospect', { text: string; afterBytes: number }[]>>

/**
 * Places a Copilot Call, then restarts its streams with `scripts` in place: the memory speech
 * adapter reads a script when a stream opens, and the Call's id is only known after the place.
 */
async function placeScripted(scripts: Script) {
  const { call } = await place({ to: PROSPECT, copilot: true })
  const id = call?.id as string
  await Transcript.stop(t.deps, id)
  for (const track of ['rep', 'prospect'] as const) {
    t.deps.transcribe.script(org, id as never, track, scripts[track] ?? [])
  }
  expect(await Transcript.start(t.deps, org, id as never)).toBe(true)
  return id
}

const heard = async (callId: string) =>
  (await t.deps.callTurns.list(org, callId as never, { rep: 0, prospect: 0 }, 100)).map(
    (turn) => `${turn.track}:${turn.text}`
  )

describe('the live Transcript of a Copilot Call', () => {
  it('plays the Copilot Disclosure and opens one stream per track', async () => {
    const { status, call } = await place({ to: PROSPECT, copilot: true })
    expect(status).toBe(201)
    expect(call?.state).toBe('live')
    const stored = await t.deps.calls.get(org, call?.id as never)
    expect(stored?.disclosure.wordingVersion).toBe(Calls.COPILOT_DISCLOSURE_WORDING.version)
    expect(stored?.disclosure.aiAssisted).toBe(true)
    expect(t.deps.transcribe.streams().map((s) => s.track)).toEqual(['rep', 'prospect'])
  })

  it('opens nothing on a Call without the Copilot', async () => {
    const { call } = await place({ to: PROSPECT })
    expect(call?.state).toBe('live')
    expect(t.deps.transcribe.streams()).toEqual([])
    expect(await Transcript.start(t.deps, org, call?.id as never)).toBe(false)
  })

  it('opens nothing and saves no turn when the Disclosure failed', async () => {
    telephony.failNext('playDisclosure', TELEPHONY_ERROR_CODES.unavailable)
    const { status } = await place({ to: PROSPECT, copilot: true })
    expect(status).toBe(502)
    expect(t.deps.transcribe.streams()).toEqual([])
    expect(telephony.calls().length).toBeGreaterThan(0)
  })

  it('refuses to start before the Disclosure has played', async () => {
    await place({ to: PROSPECT, copilot: true })
    const [line] = await t.deps.lines.list(org, { limit: 1 })
    const id = formatId('call', crypto.randomUUID())
    await t.deps.calls.insert(org, {
      id,
      lineId: line?.id as never,
      repMembershipId: formatId('mem', crypto.randomUUID()),
      prospectId: null,
      prospectNumber: PROSPECT,
      idempotency: { key: 'k'.repeat(64), fingerprint: 'f'.repeat(64) },
      createdAt: new Date(),
    })
    await t.deps.calls.setProviderCallSid(org, id, 'CA1')
    await t.deps.calls.transition(org, id, { to: 'connecting', at: new Date() })
    await t.deps.calls.transition(org, id, { to: 'disclosing', at: new Date() })
    const before = t.deps.transcribe.streams().length
    expect(await Transcript.start(t.deps, org, id as never)).toBe(false)
    expect(t.deps.transcribe.streams()).toHaveLength(before)
    expect(await heard(id)).toEqual([])
  })

  it('saves a scripted conversation in order with the right speaker', async () => {
    const id = await placeScripted({
      prospect: [
        { text: 'we need pricing', afterBytes: 100 },
        { text: 'by friday please', afterBytes: 3_000 },
      ],
      rep: [{ text: 'happy to help', afterBytes: 100 }],
    })
    speak(id, 'prospect')
    speak(id, 'rep')
    await Transcript.settled(t.deps, id)
    const turns = await t.deps.callTurns.list(org, id as never, { rep: 0, prospect: 0 }, 100)
    expect(turns.filter((x) => x.track === 'prospect').map((x) => x.text)).toEqual([
      'we need pricing',
      'by friday please',
    ])
    expect(turns.filter((x) => x.track === 'rep').map((x) => x.text)).toEqual(['happy to help'])
  })

  it('starting twice opens only two streams', async () => {
    const { call } = await place({ to: PROSPECT, copilot: true })
    expect(await Transcript.start(t.deps, org, call?.id as never)).toBe(true)
    expect(t.deps.transcribe.streams()).toHaveLength(2)
  })

  it('resumes after a pipeline restart without duplicate turns', async () => {
    const id = await placeScripted({ prospect: [{ text: 'first', afterBytes: 100 }] })
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    await Transcript.stop(t.deps, id)
    t.deps.transcribe.script(org, id as never, 'prospect', [{ text: 'second', afterBytes: 100 }])
    t.deps.transcribe.script(org, id as never, 'rep', [])
    expect(await Transcript.start(t.deps, org, id as never)).toBe(true)
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    expect(await heard(id)).toEqual(['prospect:first', 'prospect:second'])
    const turns = await t.deps.callTurns.list(org, id as never, { rep: 0, prospect: 0 }, 100)
    expect(turns.map((x) => x.sequence)).toEqual([1, 2])
  })

  it('a dropped connection replays no turn twice', async () => {
    const id = await placeScripted({ prospect: [{ text: 'only once', afterBytes: 100 }] })
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    const stream = t.deps.transcribe.streams().findLast((s) => s.track === 'prospect')
    await t.deps.transcribe.dropConnection(stream?.streamId as string)
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    expect(await heard(id)).toEqual(['prospect:only once'])
  })

  it('a speech-to-text failure leaves the Call live and marks the Transcript unavailable', async () => {
    t.deps.transcribe.failNextOpen('streaming_transcribe.rejected', 2)
    const { status, call } = await place({ to: PROSPECT, copilot: true })
    expect(status).toBe(201)
    expect(call?.state).toBe('live')
    expect(t.deps.copilot.unavailable.get(call?.id as never)).toBe('speech_to_text_failed')
    expect((await t.deps.calls.get(org, call?.id as never))?.state).toBe('live')
  })

  it('a stream that cannot reconnect marks the Transcript unavailable and keeps the Call live', async () => {
    const id = await placeScripted({})
    t.deps.transcribe.failReconnects(10)
    const stream = t.deps.transcribe.streams().findLast((s) => s.track === 'prospect')
    await t.deps.transcribe.dropConnection(stream?.streamId as string)
    expect(t.deps.copilot.unavailable.get(id as never)).toBe('stream_dropped')
    expect((await t.deps.calls.get(org, id as never))?.state).toBe('live')
  })
})

/** Reads an SSE response until it closes or `stop` says enough, as the frames' `event` + `data`. */
async function frames(response: Response, stop: (seen: string[]) => boolean) {
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const seen: string[] = []
  while (reader) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    text += decoder.decode(value)
    const parts = text.split('\n\n')
    text = parts.pop() ?? ''
    seen.push(...parts)
    if (stop(seen)) {
      await reader.cancel()
      break
    }
  }
  return seen
}

describe('GET /v1/calls/{callId}/copilot/stream', () => {
  const open = async (who: TestIdentity, id: string, lastEventId?: string) =>
    t.app.request(`/v1/calls/${id}/copilot/stream`, {
      headers: {
        ...(await t.bearer(who)),
        ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
      },
    })

  it('sends the status, then each final turn with its speaker', async () => {
    const id = await placeScripted({ prospect: [{ text: 'hello there', afterBytes: 100 }] })
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    const response = await open(rep, id)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const seen = await frames(response, (s) => s.some((f) => f.includes('transcript.turn')))
    expect(seen[0]).toContain('copilot.status')
    expect(seen[0]).toContain('"state":"live"')
    expect(seen.some((f) => f.includes('hello there') && f.includes('"speaker":"prospect"'))).toBe(
      true
    )
  })

  it('resumes after Last-Event-ID without resending a turn', async () => {
    const id = await placeScripted({
      prospect: [
        { text: 'one', afterBytes: 100 },
        { text: 'two', afterBytes: 3_000 },
      ],
    })
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    const response = await open(rep, id, 'r0.p1')
    const seen = await frames(response, (s) => s.some((f) => f.includes('transcript.turn')))
    const turns = seen.filter((f) => f.includes('transcript.turn'))
    expect(turns).toHaveLength(1)
    expect(turns[0]).toContain('two')
    expect(turns[0]).not.toContain('"text":"one"')
  })

  it('announces transcript.unavailable when speech-to-text failed', async () => {
    t.deps.transcribe.failNextOpen('streaming_transcribe.rejected', 2)
    const { call } = await place({ to: PROSPECT, copilot: true })
    const response = await open(rep, call?.id as string)
    const seen = await frames(response, (s) => s.some((f) => f.includes('transcript.unavailable')))
    expect(seen.some((f) => f.includes('transcript.unavailable'))).toBe(true)
  })

  it('does not exist for another Organization', async () => {
    const { call } = await place({ to: PROSPECT, copilot: true })
    const other = identityOf('rep', newOrganizationId())
    const response = await open(other, call?.id as string)
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'call.not_found'
    )
  })

  it('refuses a Call without the Copilot with copilot.disabled', async () => {
    const { call } = await place({ to: PROSPECT })
    const response = await open(rep, call?.id as string)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'copilot.disabled'
    )
  })
})
