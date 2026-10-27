import { expect, test } from 'bun:test'
import { createCoreHttpOrganizationDirectory } from './organization-directory'

type Call = { url: string; headers: Headers; body: unknown }
const ORG = `org_${'a'.repeat(32)}`
const USER = `usr_${'b'.repeat(32)}`
const MEM = `mem_${'c'.repeat(32)}`
const TEAM = `team_${'d'.repeat(32)}`

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A directory over a scripted fetch: each answer is a Response, or a function producing one. */
function setup(answers: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Call[] = []
  const sleeps: number[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]
    return typeof next === 'function' ? next() : (next?.clone() as Response)
  }) as typeof fetch
  const directory = createCoreHttpOrganizationDirectory({
    baseUrl: 'http://core.test/',
    token: 'secret-token-0123456789',
    fetch: fetcher,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
  })
  return { directory, calls, sleeps }
}

const unavailable = { code: 'server.unavailable' }

test('membershipOf posts to core with the bearer token and returns the Membership id', async () => {
  const { directory, calls } = setup([
    json({ found: true, membershipId: MEM, role: 'rep', organizationStatus: 'active' }),
  ])
  expect(await directory.membershipOf(ORG, USER)).toBe(MEM)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe('http://core.test/internal/v1/directory/membership')
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret-token-0123456789')
  expect(calls[0]?.body).toEqual({ organizationId: ORG, userId: USER })
})

test('membershipOf is undefined when core finds no Membership', async () => {
  const { directory } = setup([json({ found: false })])
  expect(await directory.membershipOf(ORG, USER)).toBeUndefined()
})

test('membershipOf treats a suspended or deleted Organization as no Membership', async () => {
  for (const organizationStatus of ['suspended', 'deleted']) {
    const { directory } = setup([
      json({ found: true, membershipId: MEM, role: 'rep', organizationStatus }),
    ])
    expect(await directory.membershipOf(ORG, USER)).toBeUndefined()
  }
})

test('isRep and teamExists post their checks and return the answer', async () => {
  const rep = setup([json({ isRep: true })])
  expect(await rep.directory.isRep(ORG, MEM)).toBe(true)
  expect(rep.calls[0]?.url).toBe('http://core.test/internal/v1/directory/rep-check')
  expect(rep.calls[0]?.body).toEqual({ organizationId: ORG, membershipId: MEM })

  const team = setup([json({ exists: false })])
  expect(await team.directory.teamExists(ORG, TEAM)).toBe(false)
  expect(team.calls[0]?.url).toBe('http://core.test/internal/v1/directory/team-check')
  expect(team.calls[0]?.body).toEqual({ organizationId: ORG, teamId: TEAM })
})

test('a 5xx is retried with backoff and the next answer is used', async () => {
  const { directory, calls, sleeps } = setup([json({}, 503), json({ isRep: true })])
  expect(await directory.isRep(ORG, MEM)).toBe(true)
  expect(calls).toHaveLength(2)
  expect(sleeps).toEqual([50])
})

test('a network error is retried, then exhaustion is server.unavailable', async () => {
  const { directory, calls } = setup([
    () => {
      throw new TypeError('connect ECONNREFUSED')
    },
  ])
  await expect(directory.isRep(ORG, MEM)).rejects.toMatchObject(unavailable)
  expect(calls).toHaveLength(3)
})

test('a request that outlives the timeout is abandoned and fails closed', async () => {
  let attempts = 0
  const directory = createCoreHttpOrganizationDirectory({
    baseUrl: 'http://core.test',
    token: 'secret-token-0123456789',
    timeoutMs: 10,
    retries: 1,
    sleep: async () => {},
    fetch: ((_url: string, init?: RequestInit) => {
      attempts++
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch,
  })
  await expect(directory.teamExists(ORG, TEAM)).rejects.toMatchObject(unavailable)
  expect(attempts).toBe(2)
})

test('a 4xx is not retried and fails closed', async () => {
  const { directory, calls } = setup([json({ error: 'nope' }, 401)])
  await expect(directory.membershipOf(ORG, USER)).rejects.toMatchObject(unavailable)
  expect(calls).toHaveLength(1)
})

test('a malformed or non-JSON body fails closed without a retry', async () => {
  for (const response of [
    json({ isRep: 'yes' }),
    json({ found: true }),
    new Response('<html>', { status: 200 }),
  ]) {
    const rep = setup([response])
    await expect(rep.directory.isRep(ORG, MEM)).rejects.toMatchObject(unavailable)
    expect(rep.calls).toHaveLength(1)
    const member = setup([response])
    await expect(member.directory.membershipOf(ORG, USER)).rejects.toMatchObject(unavailable)
    expect(member.calls).toHaveLength(1)
  }
})

test('teamRepsOf posts the Manager Membership and returns the Rep Membership ids', async () => {
  const rep = `mem_${'e'.repeat(32)}`
  const { directory, calls } = setup([json({ membershipIds: [rep] })])
  expect(await directory.teamRepsOf(ORG, MEM)).toEqual([rep])
  expect(calls[0]?.url).toBe('http://core.test/internal/v1/directory/team-reps')
  expect(calls[0]?.body).toEqual({ organizationId: ORG, membershipId: MEM })
})

test('teamRepsOf fails closed on a refusal or a malformed body', async () => {
  await expect(setup([json({}, 403)]).directory.teamRepsOf(ORG, MEM)).rejects.toMatchObject(
    unavailable
  )
  await expect(
    setup([json({ membershipIds: ['nope'] })]).directory.teamRepsOf(ORG, MEM)
  ).rejects.toMatchObject(unavailable)
})

test('onlineRepsOfTeam posts the Team and returns the ring members', async () => {
  const rep = `mem_${'e'.repeat(32)}`
  const { directory, calls } = setup([json({ membershipIds: [rep] })])
  expect(await directory.onlineRepsOfTeam(ORG, TEAM)).toEqual([rep])
  expect(calls[0]?.url).toBe('http://core.test/internal/v1/directory/team-ring-members')
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret-token-0123456789')
  expect(calls[0]?.body).toEqual({ organizationId: ORG, teamId: TEAM })
})

test('onlineRepsOfTeam fails closed on a 5xx after retries, a refusal or a malformed body', async () => {
  const down = setup([json({}, 503)])
  await expect(down.directory.onlineRepsOfTeam(ORG, TEAM)).rejects.toMatchObject(unavailable)
  expect(down.calls).toHaveLength(3)
  await expect(setup([json({}, 403)]).directory.onlineRepsOfTeam(ORG, TEAM)).rejects.toMatchObject(
    unavailable
  )
  await expect(
    setup([json({ membershipIds: ['nope'] })]).directory.onlineRepsOfTeam(ORG, TEAM)
  ).rejects.toMatchObject(unavailable)
})

test('onlineRepsOfTeam fails closed on a timeout', async () => {
  const slow = createCoreHttpOrganizationDirectory({
    baseUrl: 'http://core.test',
    token: 'secret-token-0123456789',
    fetch: ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      )) as typeof fetch,
    timeoutMs: 5,
    retries: 0,
  })
  await expect(slow.onlineRepsOfTeam(ORG, TEAM)).rejects.toMatchObject(unavailable)
})
