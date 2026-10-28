import { expect, test } from 'bun:test'
import { formatId, type SearchTurn } from 'tula-closeline-contract'
import * as Cards from '../src/modules/cards/service'
import { createTestDeps, newOrganizationId } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The upgrade of a shown retrieval card to an objection card runs after the card check, off the
// Call's path: one model call (the memory double answers at once), the answer's schema check, the
// cited-id check against the 5 retrieved Moments, one contract validation and one keyed update.
// Every step is O(1) in the size of the Organization. This gates our own code, not the model,
// whose own 600 ms timeout bounds the real wait. Typical best batch: 26 ms for 500 checks
// including the card check itself (about 0.05 ms each). Budget: 5x, rounded.
const BUDGET_MS = 130

const WINDOW: SearchTurn[] = [{ role: 'prospect', text: 'That is too expensive for us.' }]

test(`card upgrade: the best of ${BATCHES} batches of ${BATCH_REQUESTS} is within ${BUDGET_MS} ms`, async () => {
  const deps = createTestDeps()
  const organizationId = newOrganizationId()
  const moments = Array.from({ length: 5 }, (_, i) => ({
    callId: formatId('call', crypto.randomUUID()) as never,
    dealRecordId: formatId('deal', crypto.randomUUID()) as never,
    score: 0.9 - i / 100,
    prospect: `Too expensive ${i}`,
    repNext: `Here is why ${i}`,
  }))
  deps.evidence.load(organizationId, { moments })
  const answer = JSON.stringify({
    kind: 'objection',
    objectionType: 'price',
    text: 'Show the payback in months.',
    momentIds: [moments[0]?.callId, moments[1]?.callId],
  })
  const result = await measure(async () => {
    const callId = formatId('call', crypto.randomUUID())
    deps.llm.reply(answer)
    await Cards.onProspectTurn(deps, organizationId, callId, WINDOW, () => false)
    const [card] = await deps.copilotCards.list(organizationId, callId, 0, 1)
    // A check that left the retrieval card would be cheaper and hide a regression.
    if (card?.kind !== 'objection') {
      throw new Error('the card was not upgraded')
    }
  })
  console.log(summary('copilot-compose', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
