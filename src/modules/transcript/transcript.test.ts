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
  reportStatus,
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
  await t.deps.copilotSettings.put(org, {
    enabled: true,
    minMoments: 3,
    minDeals: 2,
    updatedAt: null,
    updatedBy: null,
  })
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
  // The Prospect picks up; the Disclosure, bridge and Transcript follow from that report.
  if (parsed.call) {
    await reportStatus(t, telephony, org, parsed.call.id, 'in-progress')
  }
  const call = parsed.call && ((await t.deps.calls.get(org, parsed.call.id as never)) as CallBody)
  return { status: response.status, call: call || parsed.call }
}

/** What the media socket does when the provider connects: opens the streams of the Call. */
const connect = (callId: string) => Transcript.attach(t.deps, org, callId as never)

const unavailable = async (callId: string) =>
  (await t.deps.calls.get(org, callId as never))?.transcriptUnavailable

/** Sends enough audio on a track for every scripted turn to be heard. */
function speak(callId: string, track: 'rep' | 'prospect') {
  Transcript.pushAudio(t.deps, callId, track, new Uint8Array(4_000))
}

type Script = Partial<Record<'rep' | 'prospect', { text: string; afterBytes: number }[]>>

/**
 * Places a Copilot Call, then connects its media socket with `scripts` in place: the memory speech
 * adapter reads a script when a stream opens, and the Call's id is only known after the place.
 */
async function placeScripted(scripts: Script) {
  const { call } = await place({ to: PROSPECT, copilot: true })
  const id = call?.id as string
  for (const track of ['rep', 'prospect'] as const) {
    t.deps.transcribe.script(org, id as never, track, scripts[track] ?? [])
  }
  expect(await connect(id)).toBe(true)
  return id
}

const heard = async (callId: string) =>
  (await t.deps.callTurns.list(org, callId as never, { rep: 0, prospect: 0 }, 100)).map(
    (turn) => `${turn.track}:${turn.text}`
  )

describe('the live Transcript of a Copilot Call', () => {
  it('plays the Copilot Disclosure, forks the tracks, and opens one stream per track on connect', async () => {
    const { status, call } = await place({ to: PROSPECT, copilot: true })
    expect(status).toBe(201)
    expect(call?.state).toBe('live')
    const stored = await t.deps.calls.get(org, call?.id as never)
    expect(stored?.disclosure.wordingVersion).toBe(Calls.COPILOT_DISCLOSURE_WORDING.version)
    expect(stored?.disclosure.aiAssisted).toBe(true)
    expect(telephony.calls().find((c) => c.callId === call?.id)?.streamId).not.toBeNull()
    // The streams open when the provider's socket connects, not before.
    expect(t.deps.transcribe.streams()).toEqual([])
    expect(await connect(call?.id as string)).toBe(true)
    expect(t.deps.transcribe.streams().map((s) => s.track)).toEqual(['rep', 'prospect'])
  })

  it('opens nothing on a Call without the Copilot', async () => {
    const { call } = await place({ to: PROSPECT })
    expect(call?.state).toBe('live')
    expect(t.deps.transcribe.streams()).toEqual([])
    expect(await Transcript.start(t.deps, org, call?.id as never)).toBe(false)
    expect(await connect(call?.id as string)).toBe(false)
    expect(t.deps.transcribe.streams()).toEqual([])
  })

  it('opens nothing and saves no turn when the Disclosure failed', async () => {
    telephony.failNext('playDisclosure', TELEPHONY_ERROR_CODES.unavailable)
    const { status, call } = await place({ to: PROSPECT, copilot: true })
    expect(status).toBe(201)
    expect(call?.state).toBe('failed')
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
    expect(await connect(id)).toBe(false)
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

  it('connecting twice opens only two streams', async () => {
    const { call } = await place({ to: PROSPECT, copilot: true })
    expect(await connect(call?.id as string)).toBe(true)
    expect(await connect(call?.id as string)).toBe(false)
    expect(await Transcript.start(t.deps, org, call?.id as never)).toBe(true)
    expect(t.deps.transcribe.streams()).toHaveLength(2)
  })

  it('a failed fork marks the Transcript unavailable and leaves the Call live', async () => {
    telephony.failNext('forkTracks', TELEPHONY_ERROR_CODES.unavailable)
    const { call } = await place({ to: PROSPECT, copilot: true })
    expect(call?.state).toBe('live')
    expect(await unavailable(call?.id as string)).toBe('speech_to_text_failed')
  })

  it('resumes after a pipeline restart without duplicate turns', async () => {
    const id = await placeScripted({ prospect: [{ text: 'first', afterBytes: 100 }] })
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    await Transcript.stop(t.deps, id)
    t.deps.transcribe.script(org, id as never, 'prospect', [{ text: 'second', afterBytes: 100 }])
    t.deps.transcribe.script(org, id as never, 'rep', [])
    expect(await connect(id)).toBe(true)
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
    expect(await connect(call?.id as string)).toBe(false)
    expect(await unavailable(call?.id as string)).toBe('speech_to_text_failed')
    expect((await t.deps.calls.get(org, call?.id as never))?.state).toBe('live')
  })

  it('a stream that cannot reconnect marks the Transcript unavailable and keeps the Call live', async () => {
    const id = await placeScripted({})
    t.deps.transcribe.failReconnects(10)
    const stream = t.deps.transcribe.streams().findLast((s) => s.track === 'prospect')
    await t.deps.transcribe.dropConnection(stream?.streamId as string)
    expect(await unavailable(id)).toBe('stream_dropped')
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

  it('sends a retrieval card after the Prospect turn it answers, and resumes after it', async () => {
    const found = Array.from({ length: 3 }, (_, i) => ({
      callId: formatId('call', crypto.randomUUID()),
      dealRecordId: formatId('deal', crypto.randomUUID()),
      score: 0.9 - i / 100,
      prospect: `Too expensive ${i}`,
      repNext: `Here is why ${i}`,
    }))
    t.deps.evidence.load(org, { moments: found as never })
    const id = await placeScripted({ prospect: [{ text: 'that costs too much', afterBytes: 100 }] })
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    const seen = await frames(await open(rep, id), (s) => s.some((f) => f.includes('copilot.card')))
    const card = seen.find((f) => f.includes('copilot.card')) ?? ''
    expect(card).toContain('"evidence":{"moments":3,"deals":3}')
    expect(card).toContain(found[0]?.callId as string)
    expect(card).toContain('id: r0.p1.c1')
    t.deps.copilot.maxStreamMs = 60
    const again = await frames(await open(rep, id, 'r0.p1.c1'), () => false)
    expect(again.some((f) => f.includes('copilot.card'))).toBe(false)
  })

  it('sends copilot.card_updated when the composer upgrades a card that was already sent', async () => {
    const found = Array.from({ length: 3 }, (_, i) => ({
      callId: formatId('call', crypto.randomUUID()),
      dealRecordId: formatId('deal', crypto.randomUUID()),
      score: 0.9 - i / 100,
      prospect: `Too expensive ${i}`,
      repNext: `Here is why ${i}`,
    }))
    t.deps.evidence.load(org, { moments: found as never })
    const id = await placeScripted({ prospect: [{ text: 'that costs too much', afterBytes: 100 }] })
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    const [card] = await t.deps.copilotCards.list(org, id, 0, 10)
    const { score: _score, ...quote } = found[0] ?? ({} as never)
    let upgraded: Promise<unknown> | undefined
    // Upgrade the card in place only once the stream has sent it, so the update is not a race.
    const seen = await frames(await open(rep, id), (s) => {
      if (upgraded === undefined && s.some((f) => /event: copilot\.card\b(?!_)/.test(f))) {
        upgraded = t.deps.copilotCards.upgrade(org, id, card?.id as never, {
          kind: 'next_step',
          nextStep: 'Book a pilot.',
          citedMoments: [
            { callId: found[0]?.callId, dealRecordId: found[0]?.dealRecordId },
          ] as never,
          quotes: [quote] as never,
        })
      }
      return s.some((f) => f.includes('copilot.card_updated'))
    })
    await upgraded
    expect(seen.find((f) => f.includes('copilot.card_updated'))).toContain('Book a pilot.')
  })

  describe('the quiet reason', () => {
    const quietOf = (seen: string[]) =>
      seen
        .filter((f) => f.includes('copilot.status'))
        .map((f) => /"quietReason":(null|"[a-z_]+")/.exec(f)?.[1])
    const moments = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        callId: formatId('call', crypto.randomUUID()),
        dealRecordId: formatId('deal', crypto.randomUUID()),
        score: 0.9 - i / 100,
        prospect: `Too expensive ${i}`,
        repNext: `Here is why ${i}`,
      })) as never
    const asked = async (prospect = [{ text: 'that costs too much', afterBytes: 100 }]) => {
      const id = await placeScripted({ prospect })
      speak(id, 'prospect')
      await Transcript.settled(t.deps, id)
      return id
    }
    const firstStatus = async (id: string) =>
      quietOf(
        await frames(await open(rep, id), (s) => s.some((f) => f.includes('copilot.status')))
      )[0]

    it('says not_enough_won_moments when the Organization has no won Moments', async () => {
      expect(await firstStatus(await asked())).toBe('"not_enough_won_moments"')
    })

    it('says playbook_unavailable when the Moment search fails', async () => {
      Object.assign(t.deps.evidence, {
        searchMoments: async () => Promise.reject(new Error('down')),
      })
      expect(await firstStatus(await asked())).toBe('"playbook_unavailable"')
    })

    it('says playbook_unavailable when the Moment search times out', async () => {
      t.deps.copilot.cardSearchTimeoutMs = 20
      Object.assign(t.deps.evidence, { searchMoments: () => new Promise<never>(() => {}) })
      expect(await firstStatus(await asked())).toBe('"playbook_unavailable"')
    })

    it('says below_minimum_evidence when Moments exist but fewer than the minimum', async () => {
      t.deps.evidence.load(org, { moments: moments(2) })
      expect(await firstStatus(await asked())).toBe('"below_minimum_evidence"')
    })

    it('sends a reason once per quiet spell, not on every turn', async () => {
      const id = await placeScripted({
        prospect: [
          { text: 'that costs too much', afterBytes: 100 },
          { text: 'still too much', afterBytes: 5_000 },
        ],
      })
      t.deps.copilot.maxStreamMs = 300
      const reading = frames(await open(rep, id), () => false)
      speak(id, 'prospect')
      speak(id, 'prospect')
      expect(quietOf(await reading).filter((q) => q === '"not_enough_won_moments"')).toHaveLength(1)
      expect(await t.deps.calls.get(org, id as never)).toMatchObject({
        copilotQuietReason: 'not_enough_won_moments',
      })
    })

    it('clears the reason when a card arrives after a quiet spell', async () => {
      const id = await placeScripted({
        prospect: [
          { text: 'that costs too much', afterBytes: 100 },
          { text: 'still too much', afterBytes: 5_000 },
        ],
      })
      speak(id, 'prospect')
      await Transcript.settled(t.deps, id)
      const reading = frames(await open(rep, id), (s) => {
        const q = quietOf(s)
        return q.includes('"not_enough_won_moments"') && q.at(-1) === 'null'
      })
      t.deps.evidence.load(org, { moments: moments(3) })
      speak(id, 'prospect')
      expect(quietOf(await reading)).toEqual(['"not_enough_won_moments"', 'null'])
      expect((await t.deps.copilotCards.list(org, id as never, 0, 10)).length).toBe(1)
    })
  })

  it('keeps the Call and its Transcript when the card search fails', async () => {
    Object.assign(t.deps, {
      evidence: {
        ...t.deps.evidence,
        searchMoments: async () => Promise.reject(new Error('down')),
      },
    })
    const id = await placeScripted({ prospect: [{ text: 'that costs too much', afterBytes: 100 }] })
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    expect(await heard(id)).toEqual(['prospect:that costs too much'])
    expect(await t.deps.copilotCards.list(org, id as never, 0, 10)).toEqual([])
    expect(await unavailable(id)).toBeNull()
  })

  it('announces transcript.unavailable when speech-to-text failed', async () => {
    t.deps.transcribe.failNextOpen('streaming_transcribe.rejected', 2)
    const { call } = await place({ to: PROSPECT, copilot: true })
    await connect(call?.id as string)
    const response = await open(rep, call?.id as string)
    const seen = await frames(response, (s) => s.some((f) => f.includes('transcript.unavailable')))
    expect(seen.some((f) => f.includes('transcript.unavailable'))).toBe(true)
  })

  it('ends after its lifetime so the client reconnects, and resumes where it stopped', async () => {
    const id = await placeScripted({ prospect: [{ text: 'before', afterBytes: 100 }] })
    t.deps.copilot.maxStreamMs = 60
    speak(id, 'prospect')
    await Transcript.settled(t.deps, id)
    const first = await frames(await open(rep, id), () => false)
    expect(first.filter((f) => f.includes('transcript.turn'))).toHaveLength(1)
    const again = await frames(await open(rep, id, 'r0.p1'), () => false)
    expect(again.filter((f) => f.includes('transcript.turn'))).toHaveLength(0)
  })

  it('shows an unavailable Transcript that another instance recorded', async () => {
    const { call } = await place({ to: PROSPECT, copilot: true })
    // The flag lives on the Call, so this instance never saw the failure itself.
    await t.deps.calls.markTranscriptUnavailable(org, call?.id as never, 'stream_dropped')
    const seen = await frames(await open(rep, call?.id as string), (s) =>
      s.some((f) => f.includes('transcript.unavailable'))
    )
    expect(seen.some((f) => f.includes('"reason":"stream_dropped"'))).toBe(true)
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
