import { beforeEach, describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createTestApp, newOrganizationId, type TestApp } from '~/testing'
import { CHAT_WORDING_PER_IP_PER_MINUTE } from './service'

const ORIGIN = 'https://acme.example'
const FOREIGN = 'https://evil.example'
const KEY = 'pk_acme_0123456789abcdef0123456789abcdef'
const WORDING = formatId('cwd', crypto.randomUUID())

let t: TestApp
let org: string

const request = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  t.app.request(
    path,
    {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { requestIP: () => ({ address: '203.0.113.7' }) }
  )

const preflight = (path: string, origin: string) =>
  request('OPTIONS', path, {
    origin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type, idempotency-key',
  })

beforeEach(async () => {
  t = await createTestApp()
  org = newOrganizationId()
  t.deps.chatSites.register(KEY, {
    organizationId: org,
    allowedOrigins: [ORIGIN],
    wording: { id: WORDING, version: 3 },
  })
})

describe('CORS on the public Chat routes', () => {
  test('an allowed origin passes the preflight and is echoed, never *', async () => {
    const response = await preflight(`/v1/public/chat/${KEY}/sessions`, ORIGIN)
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('vary')).toContain('Origin')
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'content-type, idempotency-key, authorization'
    )
  })

  test('a session path is judged by the site its token names', async () => {
    const token = `${org.slice(4)}${'a'.repeat(32)}`
    const path = `/v1/public/chat/sessions/${token}/messages`
    expect((await preflight(path, ORIGIN)).headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect((await preflight(path, FOREIGN)).headers.get('access-control-allow-origin')).toBeNull()
  })

  test('another origin, or an unknown key, gets no CORS headers', async () => {
    for (const [path, origin] of [
      [`/v1/public/chat/${KEY}/sessions`, FOREIGN],
      [`/v1/public/chat/pk_other_0123456789abcdef0123456789abcdef/sessions`, ORIGIN],
    ] as const) {
      const response = await preflight(path, origin)
      const cors = [...response.headers.keys()].filter((name) => name.startsWith('access-control-'))
      expect(cors).toEqual([])
    }
  })

  test('a real request carries the echoed origin and exposes Retry-After', async () => {
    const response = await request(
      'POST',
      `/v1/public/chat/${KEY}/sessions`,
      { origin: ORIGIN, 'idempotency-key': `start-${crypto.randomUUID()}` },
      { sourceUrl: 'https://acme.example/pricing' }
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('access-control-expose-headers')).toBe('retry-after')
    expect(response.headers.get('vary')).toContain('Origin')
  })

  test('an error from an allowed origin is still readable by the widget', async () => {
    const token = `${org.slice(4)}${'a'.repeat(32)}`
    const response = await request('GET', `/v1/public/chat/sessions/${token}/messages`, {
      origin: ORIGIN,
    })
    expect(response.status).toBe(404)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  test('a foreign origin gets the route error and no CORS headers', async () => {
    const response = await request('GET', `/v1/public/chat/${KEY}/consent-wording`, {
      origin: FOREIGN,
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('the consent wording route', () => {
  const read = (key = KEY, origin = ORIGIN) =>
    request('GET', `/v1/public/chat/${key}/consent-wording`, { origin })

  test('answers the current wording id and version for the key', async () => {
    const response = await read()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ consentWordingId: WORDING, consentWordingVersion: 3 })
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  test('an unknown key is chat.key_invalid', async () => {
    const response = await read('pk_other_0123456789abcdef0123456789abcdef')
    const body = (await response.json()) as { error: { code: string } }
    expect([response.status, body.error.code]).toEqual([404, 'chat.key_invalid'])
  })

  test('is rate limited by client address, with Retry-After', async () => {
    for (let i = 0; i < CHAT_WORDING_PER_IP_PER_MINUTE; i += 1) {
      expect((await read()).status).toBe(200)
    }
    const over = await read()
    const body = (await over.json()) as { error: { code: string } }
    expect([over.status, body.error.code]).toEqual([429, 'rate.limited'])
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(over.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })
})
