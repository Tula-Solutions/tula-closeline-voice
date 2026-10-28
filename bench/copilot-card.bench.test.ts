import { expect, test } from 'bun:test'
import { formatId, type SearchTurn } from 'tula-closeline-contract'
import * as Cards from '../src/modules/cards/service'
import { createTestDeps, newOrganizationId } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// One retrieval card check (`Cards.onProspectTurn`) runs after every final Prospect turn of a
// Copilot Call: two keyed tallies of the Call's cards (the 8 s gap, the 60 s repeat check and the
// cap of 60), one bounded Moment search (5 Moments) with its timeout timer, the minimum-evidence
// check, one contract validation and one keyed insert. Each step is O(1) in the size of the
// Organization (the tally reads at most the 60 cards of one Call). The memory model has no scripted
// answer here, so the upgrade step fails at once and the retrieval card stands (that failure path
// is part of what is timed; the upgrade itself is gated in copilot-compose.bench.test.ts).
// The Playbook is the memory double, so this gates our own code, not the vendor. Each run uses a
// fresh Call so the per-Call cap never skips the work. Typical best batch: 25 ms for 500 checks
// (about 0.05 ms each). Budget: 5x, rounded.
const BUDGET_MS = 125

const WINDOW: SearchTurn[] = [{ role: 'prospect', text: 'That is too expensive for us.' }]

test(`card check: the best of ${BATCHES} batches of ${BATCH_REQUESTS} checks is within ${BUDGET_MS} ms`, async () => {
  const deps = createTestDeps()
  const organizationId = newOrganizationId()
  deps.evidence.load(organizationId, {
    moments: Array.from({ length: 5 }, (_, i) => ({
      callId: formatId('call', crypto.randomUUID()) as never,
      dealRecordId: formatId('deal', crypto.randomUUID()) as never,
      score: 0.9 - i / 100,
      prospect: `Too expensive ${i}`,
      repNext: `Here is why ${i}`,
    })),
  })
  const result = await measure(async () => {
    const callId = formatId('call', crypto.randomUUID())
    await Cards.onProspectTurn(deps, organizationId, callId, WINDOW, () => false)
    // A check that showed no card would be cheaper and hide a regression.
    const [card] = await deps.copilotCards.list(organizationId, callId, 0, 1)
    if (card === undefined) {
      throw new Error('the card check showed no card')
    }
  })
  console.log(summary('copilot-card', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
