import { afterEach, expect, test } from 'bun:test'
import { documentIdSchema } from 'tula-closeline-contract'
import { createPlaybookHttpEvidenceSearch } from './evidence-search'

const ORG = `org_${'a'.repeat(32)}`
const SECRET = 'playbook-secret-0123456789'
const TURNS = [{ role: 'prospect' as const, text: 'What does the plan cost?' }]
const MATCH = {
  documentId: documentIdSchema.parse(`doc_${'b'.repeat(32)}`),
  fileName: 'pricing.pdf',
  page: 2,
  score: 0.8,
  snippet: 'The plan costs 10 dollars.',
}
const GOOD = { items: [MATCH], evidence: { chunks: 3, documents: 1 } }

type Seen = { headers: Headers; body: unknown }
let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => server?.stop(true))

/** A fake Playbook answering each request with the next handler (the last repeats). */
function fake(handlers: Array<(request: Request) => Response | Promise<Response>>) {
  const seen: Seen[] = []
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push({ headers: request.headers, body: await request.clone().json() })
      const handler = handlers[Math.min(seen.length - 1, handlers.length - 1)]
      return (handler as (r: Request) => Response | Promise<Response>)(request)
    },
  })
  const sleeps: number[] = []
  const search = createPlaybookHttpEvidenceSearch({
    baseUrl: `http://127.0.0.1:${server.port}/`,
    token: SECRET,
    timeoutMs: 300,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
  })
  return { search, seen, sleeps }
}

const ok = () => Response.json(GOOD)
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify({ error: { code: 'x' } }), { status: code, headers })

test('maps the response to documents, sends the Organization and secret, and returns no Moments', async () => {
  const { search, seen } = fake([ok])
  const found = await search.search(ORG, TURNS, 5)
  expect(found).toEqual({ documents: [MATCH], moments: [] })
  expect(seen).toHaveLength(1)
  expect(seen[0]?.headers.get('x-organization-id')).toBe(ORG)
  expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET}`)
  expect(seen[0]?.body).toEqual({ turns: TURNS, limit: 5 })
})

test('401 fails closed as server.unavailable without retrying and without the secret', async () => {
  const { search, seen } = fake([status(401)])
  const error = await search.search(ORG, TURNS, 5).catch((e: unknown) => e)
  expect(error).toMatchObject({ code: 'server.unavailable' })
  expect(JSON.stringify(error) + String(error)).not.toContain(SECRET)
  expect(seen).toHaveLength(1)
})

test('503 is retried once with a bounded wait, then succeeds', async () => {
  const { search, seen, sleeps } = fake([status(503, { 'retry-after': '120' }), ok])
  expect((await search.search(ORG, TURNS, 5)).documents).toHaveLength(1)
  expect(seen).toHaveLength(2)
  expect(Math.max(...sleeps)).toBeLessThanOrEqual(500)
})

test('a persistent 503 gives up after the retries as server.unavailable', async () => {
  const { search, seen } = fake([status(503)])
  await expect(search.search(ORG, TURNS, 5)).rejects.toMatchObject({ code: 'server.unavailable' })
  expect(seen).toHaveLength(2)
})

test('a slow Playbook is server.timeout after the retries', async () => {
  const { search, seen } = fake([
    () => new Promise<Response>((r) => setTimeout(() => r(ok()), 2_000)),
  ])
  await expect(search.search(ORG, TURNS, 5)).rejects.toMatchObject({ code: 'server.timeout' })
  expect(seen).toHaveLength(2)
})

test("the Playbook's own 504 is server.timeout and is not retried", async () => {
  const { search, seen } = fake([status(504)])
  await expect(search.search(ORG, TURNS, 5)).rejects.toMatchObject({ code: 'server.timeout' })
  expect(seen).toHaveLength(1)
})

test('a malformed response is rejected as server.unavailable', async () => {
  const { search } = fake([() => Response.json({ items: [{ ...MATCH, score: 'high' }] })])
  await expect(search.search(ORG, TURNS, 5)).rejects.toMatchObject({ code: 'server.unavailable' })
})

test('a request outside the contract bounds never leaves the process', async () => {
  const { search, seen } = fake([ok])
  await expect(search.search(ORG, TURNS, 99)).rejects.toMatchObject({ code: 'server.unavailable' })
  expect(seen).toHaveLength(0)
})
