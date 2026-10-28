import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createFixedClock } from 'tula-closeline-kit'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import { newOrganizationId } from '~/testing'
import { recheck } from './service'
import {
  addLine,
  addProspect,
  askInternal,
  hashOf,
  NOON_NEW_YORK,
  seedDial,
  setup,
  stepBody,
  unpause,
} from './support'

const HOUR = 3_600_000
const noon = new Date(NOON_NEW_YORK)

describe('Agent Call gate refusals', () => {
  type Case = [
    name: string,
    code: string,
    arrange: (c: Awaited<ReturnType<typeof setup>>) => Promise<string>,
  ]
  const cases: Case[] = [
    [
      'Agents paused',
      'agent.paused',
      async ({ t, org, prospect }) => {
        await t.deps.agentSettings.put(org, {
          ...DEFAULT_AGENT_SETTINGS,
          hours: [...DEFAULT_AGENT_SETTINGS.hours],
          updatedAt: '2026-01-01T00:00:00.000Z',
        })
        return prospect
      },
    ],
    ['no consent', 'consent.missing', async ({ t, org }) => addProspect(t, org, { allow: false })],
    [
      'wrong channel (consent for sms only)',
      'consent.missing',
      async ({ t, org }) => {
        const id = addProspect(t, org, { allow: false })
        t.deps.contactGuard.allow(
          { organizationId: org, prospectId: id, phone: '+12125550100' },
          'sms'
        )
        return id
      },
    ],
    [
      'consent withdrawn',
      'consent.withdrawn',
      async ({ t, org }) => {
        const id = addProspect(t, org, { allow: false })
        t.deps.contactGuard.deny(
          { organizationId: org, prospectId: id, phone: '+12125550100' },
          'phone',
          'consent.withdrawn'
        )
        return id
      },
    ],
    [
      'suppressed',
      'consent.suppressed',
      async ({ t, org }) => {
        const id = addProspect(t, org, { allow: false })
        t.deps.contactGuard.deny(
          { organizationId: org, prospectId: id, phone: '+12125550100' },
          'phone',
          'consent.suppressed',
          'stop'
        )
        return id
      },
    ],
    [
      'core unreachable',
      'consent.unavailable',
      async ({ t, prospect }) => {
        t.deps.contactGuard.setUnavailable()
        return prospect
      },
    ],
    [
      'outside hours',
      'agent.outside_hours',
      async ({ t, prospect }) => {
        t.deps.clock = createFixedClock('2026-01-05T03:00:00Z')
        return prospect
      },
    ],
    [
      'unknown zone',
      'agent.timezone_unknown',
      async ({ t, org }) => addProspect(t, org, { phone: '+80000000000', timeZone: null }),
    ],
    [
      'a dial earlier today to the number',
      'agent_call.attempts_exhausted',
      async ({ t, org, line, prospect }) => {
        await seedDial(t, org, {
          prospectId: prospect,
          lineId: line,
          at: new Date(noon.getTime() - HOUR),
        })
        return prospect
      },
    ],
    [
      'three dials in the last 7 days',
      'agent_call.attempts_exhausted',
      async ({ t, org, line, prospect }) => {
        for (const days of [2, 4, 6]) {
          await seedDial(t, org, {
            prospectId: prospect,
            lineId: line,
            at: new Date(noon.getTime() - days * 24 * HOUR),
          })
        }
        return prospect
      },
    ],
  ]

  test.each(cases)('%s refuses with %s and records the reason', async (_name, code, arrange) => {
    const ctx = await setup()
    const prospect = await arrange(ctx)
    const { t, org, line } = ctx
    const res = await askInternal(t, org, stepBody(prospect, line))
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ state: 'ended', result: 'blocked', gateCode: code })
    const stored = await t.deps.agentCalls.get(org, res.body.id)
    expect(stored).toMatchObject({ result: 'blocked', gateCode: code })
  })

  test('three dials of the Step refuse, and an answered one does too', async () => {
    const { t, org, line } = await setup()
    const enrollmentId = formatId('enr', crypto.randomUUID())
    for (const [n, answered] of [
      [3, false],
      [1, true],
    ] as const) {
      const prospect = addProspect(t, org, { phone: `+1212555020${n}` })
      for (let i = 0; i < n; i++) {
        await seedDial(t, org, {
          prospectId: prospect,
          lineId: line,
          at: new Date(noon.getTime() - (10 + i) * 24 * HOUR),
          phone: `+1212555020${n}`,
          enrollmentId,
          stepKey: `step_${n}`,
          answered,
        })
      }
      const res = await askInternal(
        t,
        org,
        stepBody(prospect, line, { enrollmentId, stepKey: `step_${n}`, attempt: 1 })
      )
      expect(res.body).toMatchObject({
        result: 'blocked',
        gateCode: 'agent_call.attempts_exhausted',
      })
    }
  })

  test('a dial yesterday does not count against today', async () => {
    const { t, org, line, prospect } = await setup()
    await seedDial(t, org, {
      prospectId: prospect,
      lineId: line,
      at: new Date(noon.getTime() - 24 * HOUR),
    })
    const res = await askInternal(t, org, stepBody(prospect, line))
    expect(res.body).toMatchObject({ state: 'queued', gateCode: null })
  })

  test('nothing in settings turns the consent gate or the window off', async () => {
    const { t, org, line } = await setup()
    expect(Object.keys(DEFAULT_AGENT_SETTINGS).join(' ')).not.toMatch(/consent|window|gate/i)
    const prospect = addProspect(t, org, { allow: false })
    const res = await askInternal(t, org, stepBody(prospect, line))
    expect(res.body).toMatchObject({ gateCode: 'consent.missing' })
  })
})

describe('Agent Call Line caps', () => {
  test('the concurrent cap defers with a retry time and uses no attempt', async () => {
    const { t, org, line, prospect } = await setup()
    t.deps.agentCalls.setLineCaps(line, { concurrent: 1 })
    await seedDial(t, org, {
      prospectId: addProspect(t, org, { phone: '+12125550301' }),
      lineId: line,
      at: noon,
      open: true,
      phone: '+12125550301',
    })
    const enrollmentId = formatId('enr', crypto.randomUUID())
    const res = await askInternal(t, org, stepBody(prospect, line, { enrollmentId }))
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      state: 'queued',
      result: null,
      gateCode: 'agent_call.line_cap_reached',
      retryAt: new Date(noon.getTime() + 60_000).toISOString(),
    })
    expect(await t.deps.agentCalls.stepAttempts(org, enrollmentId, 'first_call')).toEqual({
      dialed: 0,
      answered: false,
    })
    expect((await t.deps.agentCalls.numberDials(org, hashOf(t, org), new Date(0))).count).toBe(0)
  })

  test('the daily dial cap defers until the oldest dial leaves the 24 hours', async () => {
    const { t, org, line, prospect } = await setup()
    t.deps.agentCalls.setLineCaps(line, { daily: 1 })
    const at = new Date(noon.getTime() - 5 * HOUR)
    await seedDial(t, org, {
      prospectId: addProspect(t, org, { phone: '+12125550302' }),
      lineId: line,
      at,
      phone: '+12125550302',
    })
    const res = await askInternal(t, org, stepBody(prospect, line))
    expect(res.body).toMatchObject({
      gateCode: 'agent_call.line_cap_reached',
      retryAt: new Date(at.getTime() + 24 * HOUR).toISOString(),
    })
  })
})

describe('Agent Call request idempotency and duplicates', () => {
  test('the same key twice returns one row, 201 then 200', async () => {
    const { t, org, line, prospect } = await setup()
    const body = stepBody(prospect, line)
    const first = await askInternal(t, org, body)
    const second = await askInternal(t, org, body)
    expect([first.status, second.status]).toEqual([201, 200])
    expect(second.body.id).toBe(first.body.id)
  })

  test('a Prospect with an open Agent Call is a 409 naming it', async () => {
    const { t, org, line, prospect } = await setup()
    const first = await askInternal(t, org, stepBody(prospect, line))
    const second = await askInternal(t, org, stepBody(prospect, line))
    expect(second.status).toBe(409)
    expect(second.body.error).toMatchObject({
      code: 'agent_call.duplicate',
      details: { agentCallId: first.body.id },
    })
  })

  test('an unknown Line is 404 line.not_found', async () => {
    const { t, org, prospect } = await setup()
    const res = await askInternal(t, org, stepBody(prospect, formatId('line', crypto.randomUUID())))
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('line.not_found')
  })
})

describe('Agent Call Organization isolation', () => {
  test('Organization B neither reads nor counts against the rows of A', async () => {
    const a = await setup()
    const { t } = a
    const first = await askInternal(t, a.org, stepBody(a.prospect, a.line))
    expect(first.status).toBe(201)
    const orgB = newOrganizationId()
    await unpause(t, orgB)
    const lineB = await addLine(t, orgB)
    const prospectB = addProspect(t, orgB)
    // A has an open Call to the same number; B's request is not blocked or counted by it.
    const res = await askInternal(t, orgB, stepBody(prospectB, lineB))
    expect(res.body).toMatchObject({ state: 'queued', gateCode: null })
    expect(await t.deps.agentCalls.get(orgB, first.body.id)).toBeUndefined()
    expect(await t.deps.agentCalls.byKey(orgB, 'nope-nope-nope-nope')).toBeUndefined()
    expect((await t.deps.agentCalls.numberDials(orgB, hashOf(t, orgB), new Date(0))).count).toBe(0)
  })

  test("B's daily dials do not count against A's Line caps", async () => {
    const a = await setup()
    const orgB = newOrganizationId()
    a.t.deps.agentCalls.setLineCaps(a.line, { daily: 1 })
    await seedDial(a.t, orgB, {
      prospectId: addProspect(a.t, orgB, { phone: '+12125550303' }),
      lineId: a.line,
      at: noon,
      phone: '+12125550303',
    })
    const res = await askInternal(a.t, a.org, stepBody(a.prospect, a.line))
    expect(res.body).toMatchObject({ state: 'queued', gateCode: null })
  })
})

describe('recheck', () => {
  test('a queued Call whose consent was withdrawn is blocked when rechecked', async () => {
    const { t, org, line, prospect } = await setup()
    const made = await askInternal(t, org, stepBody(prospect, line))
    expect(made.body.state).toBe('queued')
    expect(await recheck(t.deps, org, made.body.id)).toEqual({ kind: 'allow' })
    t.deps.contactGuard.deny(
      { organizationId: org, prospectId: prospect, phone: '+12125550100' },
      'phone',
      'consent.withdrawn'
    )
    expect(await recheck(t.deps, org, made.body.id)).toEqual({
      kind: 'blocked',
      code: 'consent.withdrawn',
    })
    expect(await t.deps.agentCalls.get(org, made.body.id)).toMatchObject({
      state: 'ended',
      result: 'blocked',
      gateCode: 'consent.withdrawn',
    })
  })

  test('the window closing between request and recheck blocks the dial', async () => {
    const { t, org, line, prospect } = await setup()
    const made = await askInternal(t, org, stepBody(prospect, line))
    t.deps.clock = createFixedClock('2026-01-06T03:00:00Z')
    const decision = await recheck(t.deps, org, made.body.id)
    expect(decision).toEqual({ kind: 'blocked', code: 'agent.outside_hours' })
  })
})
