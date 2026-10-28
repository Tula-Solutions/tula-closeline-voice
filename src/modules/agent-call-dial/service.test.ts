import { beforeEach, describe, expect, test } from 'bun:test'
import { createFixedClock, TELEPHONY_ERROR_CODES } from 'tula-closeline-kit'
import { createMemoryTelephony, type MemoryTelephony } from 'tula-closeline-kit/testing'
import { LOCAL_INTERNAL_API_TOKEN } from '~/env'
import {
  addLine,
  addProspect,
  askInternal,
  NOON_NEW_YORK,
  PHONE,
  stepBody,
  unpause,
} from '~/modules/agent-call-request/support'
import { createTestApp, newOrganizationId, type TestApp } from '~/testing'
import * as Dial from './service'

const AUDIO = new Uint8Array([1, 2, 3, 4])

let telephony: MemoryTelephony
let t: TestApp
let org: string
let agentCallId: string
let callId: ReturnType<typeof Dial.callIdOf>

beforeEach(async () => {
  telephony = createMemoryTelephony()
  t = await createTestApp({ telephony })
  t.deps.clock = createFixedClock(NOON_NEW_YORK)
  org = newOrganizationId()
  await unpause(t, org as never)
  const line = await addLine(t, org as never)
  const prospect = addProspect(t, org as never)
  const res = await askInternal(t, org, stepBody(prospect, line))
  agentCallId = res.body.id
  callId = Dial.callIdOf(agentCallId)
})

const dial = () => Dial.dial(t.deps, org as never, agentCallId)

/** Plays the scripted Prospect out and hands each provider event to the dialer, as the webhook does. */
async function play(providerCallId: string) {
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
}

const providerSid = async () => (await t.deps.calls.get(org, callId))?.providerCallSid as string
const row = () => t.deps.agentCalls.get(org, agentCallId)
const sent = () => t.deps.events.depth().visible
const stored = () => t.deps.calls.get(org, callId)

describe('placing the Call', () => {
  test('dials once under the Agent Call id and stores dialing', async () => {
    const outcome = await dial()
    expect(outcome).toMatchObject({ kind: 'dialing', callId })
    expect((await row())?.state).toBe('dialing')
    expect(telephony.calls(org)).toHaveLength(1)
    expect((await stored())?.state).toBe('ringing')
  })

  test('a crash after the provider answered, then a retry, dials once', async () => {
    const down = () => Promise.reject(new Error('process died'))
    const { setProviderCallSid, transition } = t.deps.calls
    t.deps.calls.setProviderCallSid = down
    t.deps.calls.transition = down
    await expect(dial()).rejects.toThrow('process died')
    t.deps.calls.setProviderCallSid = setProviderCallSid
    t.deps.calls.transition = transition
    expect((await row())?.state).toBe('dialing')
    expect(telephony.calls(org)).toHaveLength(1)
    await dial()
    await dial()
    expect(telephony.calls(org)).toHaveLength(1)
    expect((await stored())?.providerCallSid).toBeTruthy()
  })

  test('a dial that Organization B asks for is gone', async () => {
    const other = newOrganizationId()
    expect(await Dial.dial(t.deps, other, agentCallId)).toEqual({ kind: 'gone' })
    expect(telephony.calls()).toHaveLength(0)
  })

  test('a provider that refuses stores a failed result', async () => {
    telephony.failNext('placeAgentCall', TELEPHONY_ERROR_CODES.rejected)
    expect(await dial()).toEqual({ kind: 'failed' })
    expect((await stored())?.state).toBe('failed')
    expect((await row())?.result).toBe('failed')
    expect(sent()).toBe(1)
  })
})

describe('what the Prospect does', () => {
  test('a machine ends silently as voicemail: no audio, no model call', async () => {
    telephony.script(PHONE, { kind: 'answers', detection: 'machine' })
    await dial()
    await play(await providerSid())
    expect((await row())?.result).toBe('voicemail')
    expect((await stored())?.state).toBe('missed')
    expect(t.deps.agentAudio?.spoken.size).toBe(0)
    expect(t.deps.llm.requests()).toHaveLength(0)
    expect(telephony.operations.map((o) => o.operation)).not.toContain('playDisclosure')
  })

  test('a human hears the Disclosure first, then the opening, and the Call is live', async () => {
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    await dial()
    await play(await providerSid())
    expect((await stored())?.state).toBe('live')
    const ops = telephony.operations.map((o) => o.operation)
    expect(ops.indexOf('playDisclosure')).toBeLessThan(ops.indexOf('startRecording'))
    expect(t.deps.agentAudio.spoken.get(callId)?.length).toBeGreaterThan(0)
    expect(t.deps.llm.requests()).toHaveLength(0)
  })

  test('a failed Disclosure never reaches live: no opening and no model call', async () => {
    telephony.failNext('playDisclosure', TELEPHONY_ERROR_CODES.rejected)
    await dial()
    await play(await providerSid())
    expect((await stored())?.state).toBe('failed')
    expect((await row())?.result).toBe('failed')
    expect(t.deps.agentAudio.tts.requests()).toHaveLength(0)
    expect(t.deps.llm.requests()).toHaveLength(0)
  })

  test('a delayed Disclosure never reaches live either', async () => {
    t.deps.numberTimeoutMs = 50
    telephony.stallNext('playDisclosure')
    await dial()
    await play(await providerSid())
    expect((await stored())?.state).toBe('failed')
    expect(t.deps.agentAudio.tts.requests()).toHaveLength(0)
  })

  for (const [kind, result] of [
    ['no_answer', 'no_answer'],
    ['busy', 'busy'],
    ['carrier_failure', 'failed'],
  ] as const) {
    test(`${kind} stores ${result}`, async () => {
      telephony.script(PHONE, { kind })
      await dial()
      await play(await providerSid())
      expect((await row())?.result).toBe(result)
      expect((await stored())?.answeredAt ?? null).toBeNull()
    })
  }

  test('a concurrent duplicate human detection leaves the Call live and plays one Disclosure', async () => {
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    await dial()
    const sid = await providerSid()
    const event = {
      organizationId: org as never,
      callId,
      providerCallId: sid,
      type: 'detection' as const,
      answeredBy: 'human' as const,
    }
    telephony.ring(org as never, sid)
    telephony.takeEvents()
    await Dial.onEvent(t.deps, { ...event, type: 'answered' })
    await Promise.all([Dial.onEvent(t.deps, event), Dial.onEvent(t.deps, event)])
    const ops = telephony.operations.map((o) => o.operation)
    expect(ops.filter((o) => o === 'playDisclosure')).toHaveLength(1)
    expect(ops).not.toContain('hangUp')
    expect((await stored())?.state).toBe('live')
    expect((await row())?.result).toBeNull()
    expect(sent()).toBe(0)
  })

  test('a webhook replay changes nothing and publishes once', async () => {
    telephony.script(PHONE, { kind: 'answers', detection: 'machine' })
    await dial()
    const sid = await providerSid()
    await play(sid)
    const first = await row()
    const before = sent()
    for (const type of ['answered', 'detection'] as const) {
      await Dial.onEvent(t.deps, {
        organizationId: org as never,
        callId,
        providerCallId: sid,
        type,
        answeredBy: 'machine',
      })
    }
    expect(await row()).toEqual(first)
    expect(sent()).toBe(before)
    expect(before).toBe(1)
  })
})

describe('a late machine verdict', () => {
  async function live() {
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    await dial()
    await play(await providerSid())
    expect((await stored())?.state).toBe('live')
  }
  const late = async () =>
    Dial.onEvent(t.deps, {
      organizationId: org as never,
      callId,
      providerCallId: await providerSid(),
      type: 'detection',
      answeredBy: 'machine',
    })

  test('inside the first 10 seconds it ends as voicemail', async () => {
    await live()
    t.deps.clock.advance('9s')
    await late()
    expect((await row())?.result).toBe('voicemail')
    expect((await stored())?.state).toBe('ended')
  })

  test('after 10 seconds it is ignored', async () => {
    await live()
    t.deps.clock.advance('11s')
    await late()
    expect((await stored())?.state).toBe('live')
  })
})

describe('the speech loop', () => {
  test('"not now" on the first turn ends the Call as not_now', async () => {
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    await dial()
    await play(await providerSid())
    const outcome = await Dial.turn(t.deps, {
      organizationId: org as never,
      callId,
      text: 'Not now, I am busy right now.',
      audioSeconds: 2,
    })
    expect(outcome.kind).toBe('ended')
    expect(await row()).toMatchObject({ result: 'answered', endReason: 'not_now' })
    expect(t.deps.llm.requests()).toHaveLength(0)
    expect(sent()).toBe(1)
  })

  test('a turn replayed after the Call ended adds no second turn', async () => {
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    t.deps.agentAudio.tts.speak([AUDIO])
    await dial()
    await play(await providerSid())
    const input = {
      organizationId: org as never,
      callId,
      text: 'Not now, sorry.',
      audioSeconds: 2,
    }
    await Dial.turn(t.deps, input)
    const spoken = t.deps.agentAudio.spoken.get(callId)?.length
    await Dial.turn(t.deps, input)
    expect(t.deps.agentAudio.spoken.get(callId)?.length).toBe(spoken)
    expect(sent()).toBe(1)
  })
})

describe('the ended event', () => {
  test('is published once with the v2 shape and a stable id', async () => {
    telephony.script(PHONE, { kind: 'answers', detection: 'machine' })
    await dial()
    await play(await providerSid())
    const [got] = await t.deps.events.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: 1,
      waitSeconds: 0,
    })
    expect(got?.kind === 'message' && got.envelope).toMatchObject({
      id: Dial.endedEventIdOf(agentCallId),
      type: 'voice.agent_call.ended',
    })
  })
})

describe('the routes', () => {
  const dialRoute = (id: string, who = org, token = LOCAL_INTERNAL_API_TOKEN) =>
    t.app.request(`/internal/v1/agent-calls/${id}/dial`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-organization-id': who },
    })

  async function detection(answeredBy: string, signature?: string) {
    t.deps.callEvents.addCall(org, callId)
    const path = `/webhooks/twilio/detection?organizationId=${org}&callId=${callId}`
    const body = new URLSearchParams({
      CallSid: await providerSid(),
      AnsweredBy: answeredBy,
    }).toString()
    const url = `${t.deps.env.WEBHOOK_BASE_URL ?? 'http://localhost'}${path}`
    return t.app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature ?? telephony.sign(url, body),
      },
      body,
    })
  }

  test('POST dial places the Call and answers dialing with its Call id', async () => {
    const res = await dialRoute(agentCallId)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'dialing', callId })
  })

  test('POST dial without the shared secret is 401 and dials nothing', async () => {
    expect((await dialRoute(agentCallId, org, 'wrong')).status).toBe(401)
    expect(telephony.calls()).toHaveLength(0)
  })

  test('POST dial for another Organization is 404', async () => {
    expect((await dialRoute(agentCallId, newOrganizationId())).status).toBe(404)
    expect(telephony.calls()).toHaveLength(0)
  })

  test('a signed machine detection ends the Call as voicemail, and a replay changes nothing', async () => {
    await dialRoute(agentCallId)
    expect((await detection('machine_start')).status).toBe(200)
    expect((await row())?.result).toBe('voicemail')
    const first = await row()
    expect((await detection('machine_start')).status).toBe(200)
    expect(await row()).toEqual(first)
    expect(sent()).toBe(1)
  })

  test('a detection with a bad signature is 403 and changes nothing', async () => {
    await dialRoute(agentCallId)
    expect((await detection('machine_start', 'AAAA')).status).toBe(403)
    expect((await row())?.result).toBeNull()
    expect(telephony.operations.map((o) => o.operation)).not.toContain('hangUp')
  })
})
