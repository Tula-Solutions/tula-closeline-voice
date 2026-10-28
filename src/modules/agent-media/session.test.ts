import { beforeEach, describe, expect, test } from 'bun:test'
import { createFixedClock } from 'tula-closeline-kit'
import { createMemoryTelephony, type MemoryTelephony } from 'tula-closeline-kit/testing'
import * as Dial from '~/modules/agent-call-dial/service'
import {
  addLine,
  addProspect,
  askInternal,
  NOON_NEW_YORK,
  stepBody,
  unpause,
} from '~/modules/agent-call-request/support'
import { createTestApp, newOrganizationId, type TestApp } from '~/testing'
import { authorizeAgentMedia, createAgentMediaSession } from './session'

const AUDIO = new Uint8Array(6_400)
const GOOD = 'good-signature'

let telephony: MemoryTelephony
let t: TestApp
let org: string
let agentCallId: string
let callId: ReturnType<typeof Dial.callIdOf>

beforeEach(async () => {
  telephony = createMemoryTelephony()
  t = await createTestApp({
    telephony: { ...telephony, verifyWebhook: ({ signature }) => signature === GOOD },
  })
  t.deps.clock = createFixedClock(NOON_NEW_YORK)
  org = newOrganizationId()
  await unpause(t, org as never)
  const line = await addLine(t, org as never)
  const res = await askInternal(t, org, stepBody(addProspect(t, org as never), line))
  agentCallId = res.body.id
  callId = Dial.callIdOf(agentCallId)
})

/** Dials and plays the Prospect's answer, so the Call is live with the Disclosure played. */
async function goLive() {
  await Dial.dial(t.deps, org as never, agentCallId)
  const providerCallId = (await t.deps.calls.get(org, callId))?.providerCallSid as string
  telephony.ring(org as never, providerCallId)
  for (const event of telephony.takeEvents()) {
    await Dial.onEvent(t.deps, {
      organizationId: org as never,
      callId,
      providerCallId,
      type: event.type,
      ...(event.answeredBy === undefined ? {} : { answeredBy: event.answeredBy }),
    })
  }
  return providerCallId
}

function fakeSocket() {
  const closes: { code?: number; reason?: string }[] = []
  const sent: Record<string, unknown>[] = []
  return {
    closes,
    sent,
    close: (code?: number, reason?: string) => void closes.push({ code, reason }),
    send: (data: string) => void sent.push(JSON.parse(data)),
  }
}

const upgrade = (path: string, signature: string | null = GOOD) =>
  new Request(`http://127.0.0.1:3000${path}`, {
    headers: {
      upgrade: 'websocket',
      ...(signature === null ? {} : { 'x-twilio-signature': signature }),
    },
  })
const startFrame = (sid: string, streamSid = 'MZ1') =>
  JSON.stringify({ event: 'start', start: { callSid: sid, streamSid } })

describe('authorizeAgentMedia', () => {
  test('lets a signed upgrade for an Agent Call through, on both streams', async () => {
    await Dial.dial(t.deps, org as never, agentCallId)
    const path = `/media/agent-calls/${org}/${callId}`
    expect(await authorizeAgentMedia(t.deps, upgrade(path))).toEqual({
      organizationId: org as never,
      callId,
      talk: false,
    })
    expect(await authorizeAgentMedia(t.deps, upgrade(`${path}/talk`))).toMatchObject({ talk: true })
  })

  test('refuses a missing upgrade with 426, a bad signature with 403 and an unknown Call with 404', async () => {
    const path = `/media/agent-calls/${org}/${callId}`
    const plain = await authorizeAgentMedia(t.deps, new Request(`http://x${path}`))
    expect((plain as Response).status).toBe(426)
    for (const signature of [null, 'forged']) {
      const refused = await authorizeAgentMedia(t.deps, upgrade(path, signature))
      expect((refused as Response).status).toBe(403)
    }
    const other = await authorizeAgentMedia(
      t.deps,
      upgrade(`/media/agent-calls/${newOrganizationId()}/${callId}`)
    )
    expect((other as Response).status).toBe(404)
    expect(await authorizeAgentMedia(t.deps, upgrade('/v1/calls'))).toBeUndefined()
  })
})

describe('an Agent media session', () => {
  test('the first stream is accepted and left idle', async () => {
    const sid = await goLive()
    const socket = fakeSocket()
    const session = createAgentMediaSession(
      t.deps,
      { organizationId: org as never, callId, talk: false },
      socket
    )
    await session.message(startFrame(sid))
    expect(socket.closes).toEqual([])
    expect(t.deps.transcribe.streams()).toEqual([])
    expect(t.deps.agentAudio.tts.requests()).toHaveLength(0)
    await session.closed()
  })

  test('a start for another provider Call is hung up on', async () => {
    await goLive()
    const socket = fakeSocket()
    const session = createAgentMediaSession(
      t.deps,
      { organizationId: org as never, callId, talk: true },
      socket
    )
    await session.message(startFrame(`CA${'9'.repeat(32)}`))
    expect(socket.closes[0]?.code).toBe(1008)
    expect(t.deps.transcribe.streams()).toEqual([])
    await session.closed()
  })

  test('the talk stream speaks the opening, hears the Prospect and ends the Call on "not now"', async () => {
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    const sid = await goLive()
    t.deps.transcribe.script(org as never, callId as never, 'prospect', [
      { text: 'Not now, I am busy.', afterBytes: 100 },
    ])
    const socket = fakeSocket()
    const session = createAgentMediaSession(
      t.deps,
      { organizationId: org as never, callId, talk: true },
      socket
    )
    await session.message(startFrame(sid))
    await session.message(
      JSON.stringify({
        event: 'media',
        media: { track: 'inbound', payload: Buffer.alloc(400).toString('base64') },
      })
    )
    for (let i = 0; i < 100 && socket.closes.length === 0; i++) {
      await Bun.sleep(5)
    }
    await session.closed()
    const frames = socket.sent.filter((frame) => frame.event === 'media')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((frame) => frame.streamSid === 'MZ1')).toBe(true)
    expect(socket.closes[0]?.code).toBe(1000)
    expect((await t.deps.agentCalls.get(org, agentCallId))?.endReason).toBe('not_now')
    expect(t.deps.agentAudio.spoken.get(callId)?.length).toBeGreaterThan(0)
  })

  test('the talk stream of a Call that never goes live closes without speaking', async () => {
    const socket = fakeSocket()
    const session = createAgentMediaSession(
      t.deps,
      { organizationId: org as never, callId, talk: true },
      socket
    )
    await Dial.dial(t.deps, org as never, agentCallId)
    const sid = (await t.deps.calls.get(org, callId))?.providerCallSid as string
    await session.message(startFrame(sid))
    expect(socket.closes[0]?.code).toBe(1000)
    expect(t.deps.agentAudio.tts.requests()).toHaveLength(0)
    await session.closed()
  })
})

describe('two talk sockets for one Call', () => {
  test('the second is refused, and closing the first leaves the voice to nobody else', async () => {
    t.deps.agentAudio.tts.speak([AUDIO])
    const sid = await goLive()
    const open = async () => {
      const socket = fakeSocket()
      const session = createAgentMediaSession(
        t.deps,
        { organizationId: org as never, callId, talk: true },
        socket
      )
      await session.message(startFrame(sid))
      return { socket, session }
    }
    const first = await open()
    const second = await open()
    expect(second.socket.closes[0]?.code).toBe(1008)
    await second.session.closed()
    expect(t.deps.agentAudio.attach(callId, () => undefined)).toBe(false)
    await first.session.closed()
    expect(t.deps.agentAudio.attach(callId, () => undefined)).toBe(true)
  })
})
