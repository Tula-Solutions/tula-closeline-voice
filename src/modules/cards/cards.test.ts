import { beforeEach, describe, expect, it } from 'bun:test'
import { formatId, type SearchTurn } from 'tula-closeline-contract'
import type { MomentMatch } from '~/ports/evidence-search'
import { createTestDeps, newOrganizationId, type TestDeps } from '~/testing'
import * as Cards from './service'

const WINDOW: SearchTurn[] = [{ role: 'prospect', text: 'That is too expensive for us.' }]
const never = () => false

let deps: TestDeps
let org: string
let call: string

/** `n` won-Deal Moments, each from its own Call and Deal. */
function moments(n: number, prefix = 'Too expensive'): MomentMatch[] {
  return Array.from({ length: n }, (_, i) => ({
    callId: formatId('call', crypto.randomUUID()) as MomentMatch['callId'],
    dealRecordId: formatId('deal', crypto.randomUUID()) as MomentMatch['dealRecordId'],
    score: 0.9 - i / 100,
    prospect: `${prefix} ${i}`,
    repNext: `Here is why ${i}`,
  }))
}

const stored = async (organization = org) => deps.copilotCards.list(organization, call, 0, 60)

beforeEach(() => {
  deps = createTestDeps()
  org = newOrganizationId()
  call = formatId('call', crypto.randomUUID())
})

describe('retrieval cards', () => {
  it('shows a card whose evidence is the Playbook double`s and that cites its Moments', async () => {
    const found = moments(3)
    deps.evidence.load(org, { moments: found })
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    const [card] = await stored()
    expect(card?.evidence).toEqual({ moments: 3, deals: 3 })
    expect(card?.citedMoments.map((m) => m.callId)).toEqual(found.map((m) => m.callId))
    expect(card?.quotes.map((q) => q.prospect)).toEqual(found.map((m) => m.prospect))
  })

  it('uses the Organization own minimums', async () => {
    await deps.copilotSettings.put(org, {
      enabled: true,
      minMoments: 1,
      minDeals: 1,
      updatedAt: null,
      updatedBy: null,
    })
    deps.evidence.load(org, { moments: moments(1) })
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    expect(await stored()).toHaveLength(1)
  })

  it('takes the evidence count from the Playbook, not from the few Moments it returned', async () => {
    deps.evidence.load(org, { moments: moments(2) }, { moments: 9, deals: 4 })
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    expect((await stored())[0]?.evidence).toEqual({ moments: 9, deals: 4 })
  })

  it('shows no card below the minimum evidence', async () => {
    deps.evidence.load(org, { moments: moments(2) })
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    // Enough Moments but from one Deal only.
    const same = moments(3)
    const deal = same[0]?.dealRecordId as MomentMatch['dealRecordId']
    deps.evidence.load(org, { moments: same.map((m) => ({ ...m, dealRecordId: deal })) })
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    expect(await stored()).toEqual([])
  })

  it('shows no card when the search fails, and does not throw', async () => {
    const failing = Object.assign(deps, {
      evidence: {
        ...deps.evidence,
        searchMoments: async () => Promise.reject(new Error('down')),
      },
    })
    await Cards.onProspectTurn(failing, org, call, WINDOW, never)
    expect(await stored()).toEqual([])
  })

  it('shows no card when the search is slow, and does not wait for it', async () => {
    deps.copilot.cardSearchTimeoutMs = 20
    const slow = Object.assign(deps, {
      evidence: { ...deps.evidence, searchMoments: () => new Promise<never>(() => {}) },
    })
    const started = performance.now()
    await Cards.onProspectTurn(slow, org, call, WINDOW, never)
    expect(performance.now() - started).toBeLessThan(500)
    expect(await stored()).toEqual([])
  })

  it('drops the result when a newer turn has started its own search', async () => {
    deps.evidence.load(org, { moments: moments(3) })
    await Cards.onProspectTurn(deps, org, call, WINDOW, () => true)
    expect(await stored()).toEqual([])
  })

  it('shows at most one card per 8 seconds', async () => {
    deps.evidence.load(org, { moments: moments(3) })
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    deps.evidence.load(org, { moments: moments(3, 'Another') })
    deps.clock.advance('5s')
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    expect(await stored()).toHaveLength(1)
    deps.clock.advance('4s')
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    expect(await stored()).toHaveLength(2)
  })

  it('does not repeat a Moment within 60 seconds, and may after', async () => {
    const found = moments(3)
    deps.evidence.load(org, { moments: found })
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    deps.clock.advance('20s')
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    expect(await stored()).toHaveLength(1)
    deps.clock.advance('45s')
    await Cards.onProspectTurn(deps, org, call, WINDOW, never)
    expect(await stored()).toHaveLength(2)
  })

  it('shows no more than 60 cards on a Call', async () => {
    for (let i = 0; i < 62; i++) {
      deps.evidence.load(org, { moments: moments(3) })
      await Cards.onProspectTurn(deps, org, call, WINDOW, never)
      deps.clock.advance('9s')
    }
    expect(await stored()).toHaveLength(60)
  })

  it('never gives Organization B a card citing Organization A`s Moments', async () => {
    const mine = moments(3)
    deps.evidence.load(org, { moments: mine })
    const other = newOrganizationId()
    const theirCall = formatId('call', crypto.randomUUID())
    await Cards.onProspectTurn(deps, other, theirCall, WINDOW, never)
    expect(await deps.copilotCards.list(other, theirCall, 0, 60)).toEqual([])
    expect(await deps.copilotCards.list(other, call, 0, 60)).toEqual([])
    expect(deps.evidence.searched()).toEqual([other])
  })
})
