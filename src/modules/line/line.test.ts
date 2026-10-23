import { beforeEach, describe, expect, it } from 'bun:test'
import {
  createTestApp,
  identityOf,
  newOrganizationId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

type LineBody = {
  id: string
  number: string
  country: string
  label: string | null
  state: string
  assignment: { kind: string; teamId?: string; membershipId?: string }
  createdAt: string
  releasedAt: string | null
}
type PageBody = { items: LineBody[]; nextCursor: string | null }
type ErrorBody = { error: { code: string } }

let t: TestApp
let admin: TestIdentity
let rep: TestIdentity

beforeEach(async () => {
  t = await createTestApp()
  const organizationId = newOrganizationId()
  admin = identityOf('admin', organizationId)
  rep = identityOf('rep', organizationId)
})

const buy = (who: TestIdentity, extra: Record<string, unknown> = {}) =>
  t.call(who, 'POST', '/lines', { method: 'buy', country: 'US', ...extra })

const codeOf = (body: unknown): string => (body as ErrorBody).error.code

describe('adding a Line', () => {
  it('buys a number and answers 201 with an active, unassigned Line', async () => {
    const { status, body } = await buy(admin, { areaCode: '212', label: 'Sales' })
    const line = body as LineBody
    expect(status).toBe(201)
    expect(line.state).toBe('active')
    expect(line.label).toBe('Sales')
    expect(line.number.startsWith('+1212')).toBe(true)
    expect(line.assignment).toEqual({ kind: 'unassigned' })
    expect(line.releasedAt).toBeNull()
  })

  it('ports a number as a porting Line', async () => {
    const { status, body } = await t.call(admin, 'POST', '/lines', {
      method: 'port',
      number: '+14155550100',
    })
    expect(status).toBe(201)
    expect((body as LineBody).state).toBe('porting')
    expect((body as LineBody).number).toBe('+14155550100')
  })

  it('never returns the provider id', async () => {
    const { body } = await buy(admin)
    expect(JSON.stringify(body)).not.toContain('providerSid')
    expect(JSON.stringify(body)).not.toContain('memory-sid')
  })

  it('answers line.number_unavailable (409) for a number that is live already', async () => {
    const first = await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    expect(first.status).toBe(201)
    const second = await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    expect(second.status).toBe(409)
    expect(codeOf(second.body)).toBe('line.number_unavailable')
  })

  it('gives a bought number back when the Line cannot be saved', async () => {
    await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    const before = t.deps.numbers.released.length
    await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    // A port that loses the race is released at the provider so no number is left paid for.
    expect(t.deps.numbers.released.length).toBe(before + 1)
  })

  it('answers server.unavailable (503) when the provisioner outlives its deadline', async () => {
    t.deps.numberTimeoutMs = 20
    let seen: AbortSignal | undefined
    t.deps.numbers.buy = (_request, signal) => {
      seen = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const { status, body } = await buy(admin)
    expect(status).toBe(503)
    expect(codeOf(body)).toBe('server.unavailable')
    expect(seen?.aborted).toBe(true)
    const page = (await t.call(admin, 'GET', '/lines')).body as PageBody
    expect(page.items).toHaveLength(0)
  })

  it('frees the Idempotency-Key when the provisioner times out, so a retry buys', async () => {
    t.deps.numberTimeoutMs = 20
    const real = t.deps.numbers.port
    let hang = true
    t.deps.numbers.port = (number, signal) =>
      hang
        ? new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        : real(number, signal)
    const headers = { 'idempotency-key': 'timeout-key-0001' }
    const body = { method: 'port', number: '+14155550100' }
    const first = await t.app.request('/v1/lines', {
      method: 'POST',
      headers: { ...(await t.bearer(admin)), ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(first.status).toBe(503)
    hang = false
    const retry = await t.app.request('/v1/lines', {
      method: 'POST',
      headers: { ...(await t.bearer(admin)), ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(retry.status).toBe(201)
  })

  it('gives back a number it holds when the deadline passes after the purchase, once the purchase completes', async () => {
    t.deps.numberTimeoutMs = 20
    const real = t.deps.numbers.buy
    t.deps.numbers.buy = async (request, signal) => {
      const bought = await real(request, signal)
      await new Promise((resolve) => setTimeout(resolve, 80))
      return bought
    }
    const { status, body } = await buy(admin)
    expect(status).toBe(503)
    expect(codeOf(body)).toBe('server.unavailable')
    for (let i = 0; i < 100 && t.deps.numbers.released.length === 0; i += 1) {
      await Bun.sleep(20)
    }
    expect(t.deps.numbers.released).toEqual(['mem_000001'])
  })

  it('refuses a Rep with 403 auth.forbidden', async () => {
    const { status, body } = await buy(rep)
    expect(status).toBe(403)
    expect(codeOf(body)).toBe('auth.forbidden')
  })

  it('refuses a Manager too, since only Owner and Admin add Lines', async () => {
    const { status } = await buy(identityOf('manager', admin.organizationId))
    expect(status).toBe(403)
  })

  it('rejects an invalid body with 400 request.invalid', async () => {
    const { status, body } = await t.call(admin, 'POST', '/lines', { method: 'nope' })
    expect(status).toBe(400)
    expect(codeOf(body)).toBe('request.invalid')
  })

  it('requires a token', async () => {
    const response = await t.app.request('/v1/lines')
    expect(response.status).toBe(401)
  })
})

describe('listing Lines', () => {
  it('lists newest first, in pages with a cursor', async () => {
    const ids: string[] = []
    const at = (i: number): string => ids[i] ?? ''
    for (let i = 0; i < 5; i++) {
      t.deps.clock.advance('1s')
      ids.push(((await buy(admin)).body as LineBody).id)
    }
    const first = (await t.call(admin, 'GET', '/lines?limit=2')).body as PageBody
    expect(first.items.map((l) => l.id)).toEqual([at(4), at(3)])
    expect(first.nextCursor).not.toBeNull()

    const second = (await t.call(admin, 'GET', `/lines?limit=2&cursor=${first.nextCursor}`))
      .body as PageBody
    expect(second.items.map((l) => l.id)).toEqual([at(2), at(1)])

    const third = (await t.call(admin, 'GET', `/lines?limit=2&cursor=${second.nextCursor}`))
      .body as PageBody
    expect(third.items.map((l) => l.id)).toEqual([at(0)])
    expect(third.nextCursor).toBeNull()
  })

  it('lets every role list', async () => {
    await buy(admin)
    const { status, body } = await t.call(rep, 'GET', '/lines')
    expect(status).toBe(200)
    expect((body as PageBody).items).toHaveLength(1)
  })

  it('caps the page size at 100', async () => {
    const { status, body } = await t.call(admin, 'GET', '/lines?limit=101')
    expect(status).toBe(400)
    expect(codeOf(body)).toBe('request.invalid')
  })

  it('filters by state', async () => {
    await buy(admin)
    await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    const { body } = await t.call(admin, 'GET', '/lines?state=porting')
    const page = body as PageBody
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.state).toBe('porting')
  })

  it('answers 400 request.invalid for a cursor that is not ours', async () => {
    const { status, body } = await t.call(admin, 'GET', '/lines?cursor=garbage')
    expect(status).toBe(400)
    expect(codeOf(body)).toBe('request.invalid')
  })
})

describe('reading a Line', () => {
  it('returns it', async () => {
    const line = (await buy(admin)).body as LineBody
    const { status, body } = await t.call(rep, 'GET', `/lines/${line.id}`)
    expect(status).toBe(200)
    expect((body as LineBody).id).toBe(line.id)
  })

  it('answers line.not_found (404) for an unknown id', async () => {
    const { status, body } = await t.call(
      admin,
      'GET',
      '/lines/line_00000000000000000000000000000000'
    )
    expect(status).toBe(404)
    expect(codeOf(body)).toBe('line.not_found')
  })
})

describe('assigning a Line', () => {
  it('assigns it to a Team, then a Rep, then nobody', async () => {
    const line = (await buy(admin)).body as LineBody
    const { teamId, membershipId } = seedPeople()

    const toTeam = await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, {
      kind: 'team',
      teamId,
    })
    expect(toTeam.status).toBe(200)
    expect((toTeam.body as LineBody).assignment).toEqual({ kind: 'team', teamId })

    const toRep = await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, {
      kind: 'rep',
      membershipId,
    })
    expect((toRep.body as LineBody).assignment).toEqual({ kind: 'rep', membershipId })

    const none = await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, { kind: 'unassigned' })
    expect((none.body as LineBody).assignment).toEqual({ kind: 'unassigned' })
  })

  it('answers 200 with the same Line when the assignment is already set', async () => {
    const line = (await buy(admin)).body as LineBody
    const { teamId } = seedPeople()
    const body = { kind: 'team', teamId }
    const first = await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, body)
    const again = await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, body)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
  })

  it('answers line.assignment_invalid (422) for a Team that is not in the Organization', async () => {
    const line = (await buy(admin)).body as LineBody
    const { status, body } = await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, {
      kind: 'team',
      teamId: crypto.randomUUID().replaceAll('-', '').replace(/^/, 'team_'),
    })
    expect(status).toBe(422)
    expect(codeOf(body)).toBe('line.assignment_invalid')
  })

  it('answers line.assignment_invalid (422) for a member who is not a Rep', async () => {
    const line = (await buy(admin)).body as LineBody
    const { status, body } = await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, {
      kind: 'rep',
      membershipId: `mem_${crypto.randomUUID().replaceAll('-', '')}`,
    })
    expect(status).toBe(422)
    expect(codeOf(body)).toBe('line.assignment_invalid')
  })

  it('answers line.released (409) for a released Line', async () => {
    const line = (await buy(admin)).body as LineBody
    await t.call(admin, 'POST', `/lines/${line.id}/release`)
    const { status, body } = await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, {
      kind: 'unassigned',
    })
    expect(status).toBe(409)
    expect(codeOf(body)).toBe('line.released')
  })

  it('refuses a Rep with 403', async () => {
    const line = (await buy(admin)).body as LineBody
    const { status, body } = await t.call(rep, 'PUT', `/lines/${line.id}/assignment`, {
      kind: 'unassigned',
    })
    expect(status).toBe(403)
    expect(codeOf(body)).toBe('auth.forbidden')
  })

  function seedPeople() {
    const teamId = `team_${crypto.randomUUID().replaceAll('-', '')}`
    const membershipId = `mem_${crypto.randomUUID().replaceAll('-', '')}`
    t.deps.directory.addTeam(admin.organizationId, teamId)
    t.deps.directory.addRep(admin.organizationId, membershipId)
    return { teamId, membershipId }
  }
})

describe('releasing a Line', () => {
  it('releases it, clears the assignment and gives the number back once', async () => {
    const line = (await buy(admin)).body as LineBody
    const teamId = `team_${crypto.randomUUID().replaceAll('-', '')}`
    t.deps.directory.addTeam(admin.organizationId, teamId)
    await t.call(admin, 'PUT', `/lines/${line.id}/assignment`, { kind: 'team', teamId })

    const first = await t.call(admin, 'POST', `/lines/${line.id}/release`)
    const released = first.body as LineBody
    expect(first.status).toBe(200)
    expect(released.state).toBe('released')
    expect(released.assignment).toEqual({ kind: 'unassigned' })
    expect(released.releasedAt).not.toBeNull()

    const again = await t.call(admin, 'POST', `/lines/${line.id}/release`)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(t.deps.numbers.released).toHaveLength(1)
  })

  it('gives the number back on a retry when the provider failed the first time', async () => {
    const line = (await buy(admin)).body as LineBody
    const real = t.deps.numbers.release
    let failures = 1
    t.deps.numbers.release = async (sid, signal) => {
      if (failures-- > 0) {
        throw new Error('provider down')
      }
      return real(sid, signal)
    }
    const first = await t.call(admin, 'POST', `/lines/${line.id}/release`)
    expect(first.status).toBe(500)
    const retry = await t.call(admin, 'POST', `/lines/${line.id}/release`)
    expect(retry.status).toBe(200)
    expect((retry.body as LineBody).state).toBe('released')
    expect(t.deps.numbers.released).toHaveLength(1)
    await t.call(admin, 'POST', `/lines/${line.id}/release`)
    expect(t.deps.numbers.released).toHaveLength(1)
  })

  it('answers server.unavailable when the provider never answers a release, then finishes on retry', async () => {
    const line = (await buy(admin)).body as LineBody
    t.deps.numberTimeoutMs = 20
    const real = t.deps.numbers.release
    let hang = true
    t.deps.numbers.release = (sid, signal) =>
      hang
        ? new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        : real(sid, signal)
    const first = await t.call(admin, 'POST', `/lines/${line.id}/release`)
    expect(first.status).toBe(503)
    expect(codeOf(first.body)).toBe('server.unavailable')
    hang = false
    const retry = await t.call(admin, 'POST', `/lines/${line.id}/release`)
    expect(retry.status).toBe(200)
    expect((retry.body as LineBody).state).toBe('released')
    expect(t.deps.numbers.released).toHaveLength(1)
  })

  it('logs a failed give-back through describeError, with the stack frames and a name', async () => {
    await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    t.deps.numbers.release = async () => {
      throw new Error('SECRET-VENDOR-BODY')
    }
    await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    const logged = t.deps.logLines.find((line) => line.includes('line.add.release_failed')) ?? ''
    expect(logged).toContain('"stack"')
    expect(logged).toContain('"name":"Error"')
  })

  it('frees the number to be added again', async () => {
    const added = (
      await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    ).body as LineBody
    await t.call(admin, 'POST', `/lines/${added.id}/release`)
    const again = await t.call(admin, 'POST', '/lines', { method: 'port', number: '+14155550100' })
    expect(again.status).toBe(201)
  })

  it('refuses a Rep with 403', async () => {
    const line = (await buy(admin)).body as LineBody
    const { status, body } = await t.call(rep, 'POST', `/lines/${line.id}/release`)
    expect(status).toBe(403)
    expect(codeOf(body)).toBe('auth.forbidden')
  })
})

describe('Organization isolation', () => {
  it('hides one Organization’s Lines from another Organization’s Admin', async () => {
    const line = (await buy(admin)).body as LineBody
    const outsider = identityOf('admin')

    const list = await t.call(outsider, 'GET', '/lines')
    expect((list.body as PageBody).items).toEqual([])

    const get = await t.call(outsider, 'GET', `/lines/${line.id}`)
    expect(get.status).toBe(404)
    expect(codeOf(get.body)).toBe('line.not_found')

    const assign = await t.call(outsider, 'PUT', `/lines/${line.id}/assignment`, {
      kind: 'unassigned',
    })
    expect(assign.status).toBe(404)
    expect(codeOf(assign.body)).toBe('line.not_found')

    const release = await t.call(outsider, 'POST', `/lines/${line.id}/release`)
    expect(release.status).toBe(404)
    expect(codeOf(release.body)).toBe('line.not_found')

    // The owner still sees an untouched Line.
    const mine = (await t.call(admin, 'GET', `/lines/${line.id}`)).body as LineBody
    expect(mine.state).toBe('active')
    expect(t.deps.numbers.released).toHaveLength(0)
  })
})
