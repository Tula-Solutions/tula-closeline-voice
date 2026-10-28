import { describe, expect, test } from 'bun:test'
import { BOUGHT_BY_CLOSELINE, createTwilioNumberProvisioner } from './number-provisioner'

type Call = { method: string; url: string; body: string }
type Reply = { status: number; json?: unknown } | Error

function setup(replies: Reply[]) {
  const calls: Call[] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, body: String(init.body ?? '') })
    const reply = replies.shift()
    if (!reply) {
      throw new Error('unexpected call')
    }
    if (reply instanceof Error) {
      throw reply
    }
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status,
    })
  }) as unknown as typeof fetch
  const numbers = createTwilioNumberProvisioner({
    accountSid: 'ACx',
    apiKeySid: 'SKx',
    apiKeySecret: 'secret',
    webhookBaseUrl: 'https://voice.example',
    fetch: fakeFetch,
    sleep: async () => undefined,
  })
  return { calls, numbers }
}
const signal = new AbortController().signal
const A = '/2010-04-01/Accounts/ACx'
const owned = { sid: 'PN1', phone_number: '+14155550100' }

describe('twilio number provisioner', () => {
  test('buy searches, buys once, marks it and points the webhook', async () => {
    const { calls, numbers } = setup([
      { status: 200, json: { available_phone_numbers: [{ phone_number: '+14155550100' }] } },
      { status: 201, json: owned },
    ])
    const bought = await numbers.buy({ country: 'US', areaCode: '415' }, signal)
    expect(bought).toEqual({
      number: '+14155550100',
      country: 'US',
      providerSid: 'PN1',
      state: 'active',
    })
    expect(calls[0]?.url).toBe(
      `https://api.twilio.com${A}/AvailablePhoneNumbers/US/Local.json?AreaCode=415`
    )
    const form = new URLSearchParams(calls[1]?.body)
    expect(calls[1]?.method).toBe('POST')
    expect(form.get('PhoneNumber')).toBe('+14155550100')
    expect(form.get('FriendlyName')).toBe(BOUGHT_BY_CLOSELINE)
    expect(form.get('VoiceUrl')).toBe('https://voice.example/webhooks/twilio/inbound')
  })

  test('buy with nothing available is line.number_unavailable and buys nothing', async () => {
    const { calls, numbers } = setup([{ status: 200, json: { available_phone_numbers: [] } }])
    await expect(numbers.buy({ country: 'US' }, signal)).rejects.toMatchObject({
      code: 'line.number_unavailable',
    })
    expect(calls).toHaveLength(1)
  })

  test('buy retries the search on a 503 but never the purchase', async () => {
    const { calls, numbers } = setup([
      { status: 503 },
      { status: 200, json: { available_phone_numbers: [{ phone_number: '+14155550100' }] } },
      new Error('connection reset'),
    ])
    await expect(numbers.buy({ country: 'US' }, signal)).rejects.toMatchObject({
      code: 'server.unavailable',
    })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST'])
  })

  test('port attaches a number the account owns', async () => {
    const { calls, numbers } = setup([
      { status: 200, json: { incoming_phone_numbers: [owned] } },
      { status: 200, json: owned },
    ])
    const ported = await numbers.port('+14155550100', signal)
    expect(ported).toMatchObject({ providerSid: 'PN1', state: 'active', country: 'US' })
    expect(calls[0]?.url).toContain('PhoneNumber=%2B14155550100')
    expect(calls[1]?.url).toBe(`https://api.twilio.com${A}/IncomingPhoneNumbers/PN1.json`)
    expect(new URLSearchParams(calls[1]?.body).get('VoiceUrl')).toBe(
      'https://voice.example/webhooks/twilio/inbound'
    )
  })

  test('port refuses a number outside the account', async () => {
    const { calls, numbers } = setup([{ status: 200, json: { incoming_phone_numbers: [] } }])
    await expect(numbers.port('+14155550199', signal)).rejects.toMatchObject({
      code: 'line.number_unavailable',
    })
    expect(calls).toHaveLength(1)
  })

  test('port refuses a number Closeline bought, so a later release cannot delete it', async () => {
    const { calls, numbers } = setup([
      {
        status: 200,
        json: { incoming_phone_numbers: [{ ...owned, friendly_name: BOUGHT_BY_CLOSELINE }] },
      },
    ])
    await expect(numbers.port('+14155550100', signal)).rejects.toMatchObject({
      code: 'line.number_unavailable',
    })
    expect(calls).toHaveLength(1)
  })

  test('port refuses a country voice does not sell in, before any call', async () => {
    const { calls, numbers } = setup([])
    await expect(numbers.port('+33123456789', signal)).rejects.toMatchObject({
      code: 'line.number_unavailable',
    })
    expect(calls).toHaveLength(0)
  })

  test('release deletes a number Closeline bought', async () => {
    const { calls, numbers } = setup([
      { status: 200, json: { ...owned, friendly_name: BOUGHT_BY_CLOSELINE } },
      { status: 204 },
    ])
    await numbers.release('PN1', signal)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE'])
  })

  test('release of an attached number only clears the webhook', async () => {
    const { calls, numbers } = setup([
      { status: 200, json: { ...owned, friendly_name: 'Main office' } },
      { status: 200, json: owned },
    ])
    await numbers.release('PN1', signal)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST'])
    expect(new URLSearchParams(calls[1]?.body).get('VoiceUrl')).toBe('')
  })

  test('release of a number already gone succeeds', async () => {
    const gone = setup([{ status: 404, json: { code: 20404 } }])
    await gone.numbers.release('PN1', signal)
    const raced = setup([
      { status: 200, json: { ...owned, friendly_name: BOUGHT_BY_CLOSELINE } },
      { status: 404 },
    ])
    await raced.numbers.release('PN1', signal)
  })

  test('every call honours the abort signal', async () => {
    const { calls, numbers } = setup([])
    const aborted = AbortSignal.abort(new Error('stop'))
    await expect(numbers.buy({ country: 'US' }, aborted)).rejects.toThrow('stop')
    await expect(numbers.port('+14155550100', aborted)).rejects.toThrow('stop')
    await expect(numbers.release('PN1', aborted)).rejects.toThrow('stop')
    expect(calls).toHaveLength(0)
  })
})
