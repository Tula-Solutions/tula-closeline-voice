import { describe, expect, test } from 'bun:test'
import {
  type EnrollmentId,
  formatId,
  type LineId,
  type OrganizationId,
  type ProspectId,
} from 'tula-closeline-contract'
import {
  AgentCallOpenError,
  type AgentCallStore,
  type NewAgentCall,
} from '~/ports/agent-call-store'

/** A fresh Organization id. */
export const newOrganizationId = (): OrganizationId => formatId('org', crypto.randomUUID())

/** A store under test and the two things an adapter does differently: Lines and dials. */
export type AgentCallHarness = {
  store: AgentCallStore
  newLine: (organizationId: OrganizationId) => Promise<LineId>
  /** What the dialer will do: marks the Agent Call as dialed to the number at `at`. */
  dial: (
    organizationId: OrganizationId,
    id: string,
    dial: { lineId: LineId; hash: Uint8Array; at: Date; open?: boolean; answered?: boolean }
  ) => Promise<void>
}

const AT = new Date('2026-01-05T17:00:00.000Z')

const queued = (lineId: LineId, extra: Partial<NewAgentCall> = {}): NewAgentCall => ({
  id: formatId('acl', crypto.randomUUID()),
  idempotencyKey: `key-${crypto.randomUUID()}`,
  source: 'rep_request',
  prospectId: formatId('prs', crypto.randomUUID()),
  lineId,
  enrollmentId: null,
  stepKey: null,
  requestedByMembershipId: formatId('mem', crypto.randomUUID()),
  attempt: 1,
  state: 'queued',
  result: null,
  gateCode: null,
  retryAt: AT,
  // Created before any dial a test records, as the table requires.
  createdAt: new Date(AT.getTime() - 30 * 86_400_000),
  ...extra,
})

const hash = (byte: number) => new Uint8Array(32).fill(byte)

/** The behaviour every {@link AgentCallStore} must show, run against each adapter. */
export function agentCallStoreBehaviour(name: string, make: () => AgentCallHarness): void {
  describe(`AgentCallStore (${name})`, () => {
    test('insert stores a row; the same key answers the first row with created false', async () => {
      const { store, newLine } = make()
      const org = newOrganizationId()
      const line = await newLine(org)
      const first = await store.insert(org, queued(line, { idempotencyKey: 'same-key-0000000001' }))
      const again = await store.insert(org, queued(line, { idempotencyKey: 'same-key-0000000001' }))
      expect(first.created).toBe(true)
      expect(again).toMatchObject({ created: false, call: { id: first.call.id } })
      expect(await store.byKey(org, 'same-key-0000000001')).toEqual(first.call)
      expect(await store.get(org, first.call.id)).toEqual(first.call)
    })

    test('a second open Agent Call to a Prospect is AgentCallOpenError naming the first', async () => {
      const { store, newLine } = make()
      const org = newOrganizationId()
      const line = await newLine(org)
      const prospectId = formatId('prs', crypto.randomUUID())
      const first = await store.insert(org, queued(line, { prospectId }))
      await expect(store.insert(org, queued(line, { prospectId }))).rejects.toMatchObject({
        name: 'AgentCallOpenError',
        agentCallId: first.call.id,
      })
      expect(await store.openFor(org, prospectId)).toMatchObject({ id: first.call.id })
      expect(new AgentCallOpenError('x')).toBeInstanceOf(Error)
    })

    test('a blocked row is not open, so the Prospect can be asked again', async () => {
      const { store, newLine } = make()
      const org = newOrganizationId()
      const line = await newLine(org)
      const prospectId = formatId('prs', crypto.randomUUID())
      const blocked = queued(line, {
        prospectId,
        state: 'ended',
        result: 'blocked',
        gateCode: 'agent.paused',
        retryAt: null,
      })
      await store.insert(org, blocked)
      expect(await store.openFor(org, prospectId)).toBeUndefined()
      const next = await store.insert(org, queued(line, { prospectId }))
      expect(next.created).toBe(true)
    })

    test('settle blocks or defers a queued row', async () => {
      const { store, newLine } = make()
      const org = newOrganizationId()
      const line = await newLine(org)
      const a = await store.insert(org, queued(line))
      const b = await store.insert(org, queued(line))
      const retryAt = new Date(AT.getTime() + 60_000)
      await store.settle(org, a.call.id, { kind: 'blocked', gateCode: 'consent.withdrawn', at: AT })
      await store.settle(org, b.call.id, {
        kind: 'deferred',
        gateCode: 'agent_call.line_cap_reached',
        retryAt,
      })
      expect(await store.get(org, a.call.id)).toMatchObject({
        state: 'ended',
        result: 'blocked',
        gateCode: 'consent.withdrawn',
        retryAt: null,
      })
      expect(await store.get(org, b.call.id)).toMatchObject({
        state: 'queued',
        gateCode: 'agent_call.line_cap_reached',
        retryAt: retryAt.toISOString(),
      })
    })

    test('numberDials counts dials of one number since a time, and the oldest', async () => {
      const { store, newLine, dial } = make()
      const org = newOrganizationId()
      const line = await newLine(org)
      const days = [3, 2, 1]
      for (const day of days) {
        const { call } = await store.insert(org, queued(line))
        await dial(org, call.id, {
          lineId: line,
          hash: hash(7),
          at: new Date(AT.getTime() - day * 86_400_000),
          open: false,
        })
      }
      const other = await store.insert(org, queued(line))
      await dial(org, other.call.id, { lineId: line, hash: hash(8), at: AT, open: false })
      const since = new Date(AT.getTime() - 2.5 * 86_400_000)
      expect(await store.numberDials(org, hash(7), since)).toEqual({
        count: 2,
        oldestAt: new Date(AT.getTime() - 2 * 86_400_000),
      })
      expect((await store.numberDials(org, hash(9), new Date(0))).count).toBe(0)
    })

    test('stepAttempts counts dialed attempts of a Step and whether one was answered', async () => {
      const { store, newLine, dial } = make()
      const org = newOrganizationId()
      const line = await newLine(org)
      const enrollmentId: EnrollmentId = formatId('enr', crypto.randomUUID())
      const step = {
        enrollmentId,
        stepKey: 'first_call',
        source: 'campaign_step',
        requestedByMembershipId: null,
      } as const
      const undialed = await store.insert(
        org,
        queued(line, { ...step, idempotencyKey: `${enrollmentId}:first_call:1` })
      )
      expect(await store.stepAttempts(org, enrollmentId, 'first_call')).toEqual({
        dialed: 0,
        answered: false,
      })
      await dial(org, undialed.call.id, { lineId: line, hash: hash(1), at: AT, open: false })
      const second = await store.insert(
        org,
        queued(line, { ...step, attempt: 2, idempotencyKey: `${enrollmentId}:first_call:2` })
      )
      await dial(org, second.call.id, {
        lineId: line,
        hash: hash(1),
        at: AT,
        open: false,
        answered: true,
      })
      expect(await store.stepAttempts(org, enrollmentId, 'first_call')).toEqual({
        dialed: 2,
        answered: true,
      })
      expect(await store.stepAttempts(org, enrollmentId, 'other_step')).toEqual({
        dialed: 0,
        answered: false,
      })
    })

    test('lineUsage counts open calls and dials of the Line and reads its caps', async () => {
      const { store, newLine, dial } = make()
      const org = newOrganizationId()
      const line = await newLine(org)
      const open = await store.insert(org, queued(line))
      await dial(org, open.call.id, { lineId: line, hash: hash(1), at: AT, open: true })
      const done = await store.insert(org, queued(line))
      const earlier = new Date(AT.getTime() - 3_600_000)
      await dial(org, done.call.id, { lineId: line, hash: hash(2), at: earlier, open: false })
      const usage = await store.lineUsage(org, line, new Date(AT.getTime() - 86_400_000))
      expect(usage).toEqual({
        maxConcurrentAgentCalls: 3,
        dailyAgentDialCap: 150,
        open: 1,
        dials: 2,
        oldestDialAt: earlier,
      })
    })

    test('Organization B reads nothing of A and its counts are separate', async () => {
      const { store, newLine, dial } = make()
      const a = newOrganizationId()
      const b = newOrganizationId()
      const lineA = await newLine(a)
      const lineB = await newLine(b)
      const prospectId: ProspectId = formatId('prs', crypto.randomUUID())
      const row = await store.insert(
        a,
        queued(lineA, { prospectId, idempotencyKey: 'shared-key-000000001' })
      )
      await dial(a, row.call.id, { lineId: lineA, hash: hash(5), at: AT, open: true })
      expect(await store.get(b, row.call.id)).toBeUndefined()
      expect(await store.byKey(b, 'shared-key-000000001')).toBeUndefined()
      expect(await store.openFor(b, prospectId)).toBeUndefined()
      expect((await store.numberDials(b, hash(5), new Date(0))).count).toBe(0)
      expect(await store.lineUsage(b, lineB, new Date(0))).toMatchObject({ open: 0, dials: 0 })
      // The same key and Prospect are free in B.
      const mine = await store.insert(
        b,
        queued(lineB, { prospectId, idempotencyKey: 'shared-key-000000001' })
      )
      expect(mine.created).toBe(true)
    })
  })
}
