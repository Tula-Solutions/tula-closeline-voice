import { describe, expect, it } from 'bun:test'
import { formatId, type VoiceCall } from 'tula-closeline-contract'
import { signTwilioRequest } from 'tula-closeline-kit'
import { createApp } from '~/app'
import { serveOptions } from '~/http/serve'
import {
  createStubbedTwilio,
  newCallId,
  TEST_AUTH_TOKEN,
  TEST_BASE_URL,
} from '~/modules/webhook/twilio-fixture'
import { createTestDeps, newOrganizationId } from '~/testing'
import { mediaUrl } from '../transcript/service'
import { authorizeMedia, createMediaSession } from './handler'

const SID = `CA${'1'.repeat(32)}`
const T0 = new Date('2026-01-01T00:00:00.000Z')

function setup() {
  const deps = createTestDeps({
    env: { WEBHOOK_BASE_URL: TEST_BASE_URL },
    telephony: createStubbedTwilio(),
  })
  return { deps, org: newOrganizationId() }
}

/** A live Call with an AI-assisted Disclosure played, as a Copilot Call is when it is bridged. */
async function liveCall(
  deps: ReturnType<typeof setup>['deps'],
  org: string,
  options: { copilot?: boolean } = {}
) {
  const id = newCallId() as VoiceCall['id']
  await deps.calls.insert(org, {
    id,
    lineId: formatId('line', crypto.randomUUID()) as never,
    repMembershipId: formatId('mem', crypto.randomUUID()),
    prospectId: null,
    prospectNumber: '+14155550100',
    copilot: options.copilot ?? true,
    createdAt: T0,
  })
  await deps.calls.setProviderCallSid(org, id as never, SID)
  await deps.calls.transition(org, id as never, { to: 'connecting', at: T0 })
  await deps.calls.transition(org, id as never, { to: 'disclosing', at: T0 })
  await deps.calls.recordDisclosure(org, id as never, {
    wordingVersion: 1,
    aiAssisted: true,
    playedAt: T0,
  })
  await deps.calls.recordRecordingStarted(org, id as never, T0)
  await deps.calls.transition(org, id as never, { to: 'live', at: T0 })
  return id
}

const sign = (url: string, token = TEST_AUTH_TOKEN) => signTwilioRequest(token, url, {})

function upgradeRequest(org: string, callId: string, signature: string | null) {
  return new Request(`http://127.0.0.1:3000/media/${org}/${callId}`, {
    headers: {
      upgrade: 'websocket',
      ...(signature === null ? {} : { 'x-twilio-signature': signature }),
    },
  })
}

describe('authorizeMedia', () => {
  it('lets a signed upgrade for a Copilot Call through, whatever the Host says', async () => {
    const { deps, org } = setup()
    const id = await liveCall(deps, org)
    const signature = sign(mediaUrl(deps.env, id, org))
    const result = await authorizeMedia(deps, upgradeRequest(org, id, signature))
    expect(result).toEqual({ organizationId: org, callId: id })
  })

  it('accepts the signature over the http form of the URL too', async () => {
    const { deps, org } = setup()
    const id = await liveCall(deps, org)
    const signature = sign(`${TEST_BASE_URL}/media/${org}/${id}`)
    expect(await authorizeMedia(deps, upgradeRequest(org, id, signature))).toEqual({
      organizationId: org,
      callId: id,
    })
  })

  it.each([
    ['no signature', null],
    ['a signature made with another token', 'wrong-token'],
    ['a garbage signature', 'AAAA'],
  ])('refuses %s with 403', async (_label, kind) => {
    const { deps, org } = setup()
    const id = await liveCall(deps, org)
    const signature =
      kind === 'wrong-token' ? sign(mediaUrl(deps.env, id, org), 'another-token-0123456789') : kind
    const result = await authorizeMedia(deps, upgradeRequest(org, id, signature))
    expect((result as Response).status).toBe(403)
  })

  it('refuses a signature made for another Organization or Call', async () => {
    const { deps, org } = setup()
    const id = await liveCall(deps, org)
    const otherOrg = newOrganizationId()
    const forOther = sign(mediaUrl(deps.env, id, otherOrg))
    expect(
      ((await authorizeMedia(deps, upgradeRequest(org, id, forOther))) as Response).status
    ).toBe(403)
    const forOtherCall = sign(mediaUrl(deps.env, newCallId(), org))
    expect(
      ((await authorizeMedia(deps, upgradeRequest(org, id, forOtherCall))) as Response).status
    ).toBe(403)
  })

  it('is 404 for a Call of another Organization, an unknown Call and a Call without the Copilot', async () => {
    const { deps, org } = setup()
    const plain = await liveCall(deps, org, { copilot: false })
    const real = await liveCall(deps, org)
    const otherOrg = newOrganizationId()
    for (const [o, id] of [
      [org, plain],
      [org, newCallId()],
      [otherOrg, real],
    ] as const) {
      const signature = sign(mediaUrl(deps.env, id, o))
      expect(
        ((await authorizeMedia(deps, upgradeRequest(o, id, signature))) as Response).status
      ).toBe(404)
    }
  })

  it('is 426 for a plain request and ignores other paths', async () => {
    const { deps, org } = setup()
    const id = await liveCall(deps, org)
    const plain = new Request(`http://x/media/${org}/${id}`)
    expect(((await authorizeMedia(deps, plain)) as Response).status).toBe(426)
    expect(await authorizeMedia(deps, new Request('http://x/v1/calls'))).toBeUndefined()
  })
})

function fakeSocket() {
  const closes: { code?: number; reason?: string }[] = []
  return { closes, close: (code?: number, reason?: string) => void closes.push({ code, reason }) }
}

const frame = (value: unknown) => JSON.stringify(value)
const startFrame = (sid = SID) => frame({ event: 'start', start: { callSid: sid } })
const mediaFrame = (track: 'inbound' | 'outbound', bytes = 4_000) =>
  frame({ event: 'media', media: { track, payload: Buffer.alloc(bytes).toString('base64') } })

async function openSession(options: { lifetimeMs?: number } = {}) {
  const { deps, org } = setup()
  const id = await liveCall(deps, org)
  const socket = fakeSocket()
  deps.transcribe.script(org, id as never, 'prospect', [
    { text: 'we need pricing', afterBytes: 100 },
  ])
  deps.transcribe.script(org, id as never, 'rep', [{ text: 'happy to help', afterBytes: 100 }])
  const session = createMediaSession(
    deps,
    { organizationId: org, callId: id as never },
    socket,
    options.lifetimeMs
  )
  const turns = async () =>
    (await deps.callTurns.list(org, id as never, { rep: 0, prospect: 0 }, 100)).map(
      (turn) => `${turn.track}:${turn.text}`
    )
  const unavailable = async () => (await deps.calls.get(org, id as never))?.transcriptUnavailable
  return { deps, org, id, socket, session, turns, unavailable }
}

describe('a media session', () => {
  it('feeds inbound audio to the Prospect and outbound to the Rep, and stores their turns', async () => {
    const m = await openSession()
    await m.session.message(frame({ event: 'connected' }))
    await m.session.message(startFrame())
    await m.session.message(mediaFrame('inbound'))
    await m.session.message(mediaFrame('outbound'))
    await m.session.message(frame({ event: 'stop' }))
    await (await import('~/modules/transcript/service')).settled(m.deps, m.id)
    expect(m.socket.closes[0]?.code).toBe(1000)
    await m.session.closed()
    expect((await m.turns()).sort()).toEqual(['prospect:we need pricing', 'rep:happy to help'])
    expect(await m.unavailable()).toBeNull()
    expect(m.deps.copilot.streams.size).toBe(0)
  })

  it('ignores audio before start and opens no stream', async () => {
    const m = await openSession()
    await m.session.message(mediaFrame('inbound'))
    expect(m.deps.transcribe.streams()).toEqual([])
    await m.session.closed()
    expect(await m.unavailable()).toBeNull()
  })

  it('hangs up on a start for another provider Call', async () => {
    const m = await openSession()
    await m.session.message(startFrame(`CA${'9'.repeat(32)}`))
    expect(m.socket.closes[0]?.code).toBe(1008)
    expect(m.deps.transcribe.streams()).toEqual([])
    await m.session.closed()
  })

  it('hangs up on a frame that is not JSON and drops an oversized or empty chunk', async () => {
    const m = await openSession()
    await m.session.message('not json')
    expect(m.socket.closes[0]?.code).toBe(1008)
    const n = await openSession()
    await n.session.message(startFrame())
    await n.session.message(mediaFrame('inbound', 70_000))
    await n.session.message(frame({ event: 'media', media: { track: 'inbound', payload: '' } }))
    await n.session.message(frame({ event: 'media', media: { track: 'other', payload: 'AAAA' } }))
    expect(n.socket.closes).toEqual([])
    await n.session.closed()
  })

  it('refuses a second socket for a Call this instance already serves', async () => {
    const m = await openSession()
    await m.session.message(startFrame())
    const second = fakeSocket()
    const again = createMediaSession(
      m.deps,
      { organizationId: m.org, callId: m.id as never },
      second
    )
    await again.message(startFrame())
    expect(second.closes[0]?.code).toBe(1008)
    expect(m.deps.transcribe.streams()).toHaveLength(2)
    await again.closed()
    expect(m.deps.copilot.streams.has(m.id)).toBe(true)
    await m.session.closed()
  })

  it('marks the Transcript unavailable when the socket drops while the Call is live', async () => {
    const m = await openSession()
    await m.session.message(startFrame())
    await m.session.closed()
    expect(await m.unavailable()).toBe('stream_dropped')
    expect((await m.deps.calls.get(m.org, m.id as never))?.state).toBe('live')
  })

  it('does not mark a Transcript unavailable when the Call already ended', async () => {
    const m = await openSession()
    await m.session.message(startFrame())
    await m.deps.calls.transition(
      m.org,
      m.id as never,
      { to: 'ended', at: T0, endReason: 'completed' } as never
    )
    await m.session.closed()
    expect(await m.unavailable()).toBeNull()
  })

  it('closes the socket at its lifetime and reports the Transcript lost', async () => {
    const m = await openSession({ lifetimeMs: 20 })
    await m.session.message(startFrame())
    await Bun.sleep(60)
    expect(m.socket.closes[0]?.code).toBe(1001)
    await m.session.closed()
    expect(await m.unavailable()).toBe('stream_dropped')
  })

  it('hangs up when the Call ended and its streams closed', async () => {
    const m = await openSession()
    await m.session.message(startFrame())
    await (await import('~/modules/transcript/service')).stop(m.deps, m.id)
    await m.session.message(mediaFrame('inbound'))
    expect(m.socket.closes[0]?.code).toBe(1000)
    await m.session.closed()
    expect(await m.unavailable()).toBeNull()
  })
})

describe('the media route over a real socket', () => {
  async function serve() {
    const m = await openSession()
    const app = createApp(m.deps)
    const server = Bun.serve({ ...serveOptions(m.deps, app), port: 0 })
    return { ...m, server, stop: () => server.stop(true) }
  }

  const connect = (
    port: number,
    org: string,
    id: string,
    signature: string | null
  ): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/media/${org}/${id}`, {
        headers: signature === null ? {} : { 'x-twilio-signature': signature },
      } as never)
      ws.onopen = () => resolve(ws)
      ws.onerror = () => reject(new Error('refused'))
    })

  it('upgrades a signed request and stores the turns it hears', async () => {
    const s = await serve()
    try {
      const ws = await connect(
        s.server.port as number,
        s.org,
        s.id,
        sign(mediaUrl(s.deps.env, s.id, s.org))
      )
      ws.send(startFrame())
      ws.send(mediaFrame('inbound'))
      for (let i = 0; i < 100 && (await s.turns()).length === 0; i++) {
        await Bun.sleep(20)
      }
      expect(await s.turns()).toEqual(['prospect:we need pricing'])
      ws.send(frame({ event: 'stop' }))
      ws.close()
    } finally {
      s.stop()
    }
  })

  it('refuses an unsigned or wrongly signed request before upgrading', async () => {
    const s = await serve()
    try {
      const port = s.server.port as number
      await expect(connect(port, s.org, s.id, null)).rejects.toThrow('refused')
      await expect(
        connect(
          port,
          s.org,
          s.id,
          sign(mediaUrl(s.deps.env, s.id, s.org), 'another-token-0123456789')
        )
      ).rejects.toThrow('refused')
      expect(s.deps.transcribe.streams()).toEqual([])
    } finally {
      s.stop()
    }
  })
})
