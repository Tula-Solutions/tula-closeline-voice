import { expect, test } from 'bun:test'
import { createFixedClock } from 'tula-closeline-kit'
import { evaluateGate } from '../src/modules/agent-call-request/service'
import { PHONE, setup } from '../src/modules/agent-call-request/support'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The Agent Call gate (`evaluateGate`) is the hot path of every Agent Call request: the pause read,
// the Contact Check, the calling window, the three attempt counts and the Line usage. It is O(1)
// in the size of the Organization: about six keyed or indexed reads and no loop over Prospects or
// Calls. The Contact Check and storage are memory adapters, so this gates our own code, not core
// or Postgres. Typical best batch: 22 ms for 500 gates (about 0.04 ms each). Budget: 5x, rounded.
const BUDGET_MS = 110

test(`agent call gate: the best of ${BATCHES} batches of ${BATCH_REQUESTS} requests is within ${BUDGET_MS} ms`, async () => {
  const { t, org, line, prospect } = await setup()
  t.deps.clock = createFixedClock('2026-01-05T17:00:00Z')
  const input = {
    organizationId: org,
    prospectId: prospect,
    lineId: line,
    prospect: { phone: PHONE, timeZone: 'America/New_York' },
    step: null,
  }
  const result = await measure(async () => {
    const decision = await evaluateGate(t.deps, input)
    if (decision.kind !== 'allow') {
      throw new Error(`the gate answered ${decision.kind}, not allow`)
    }
  })
  console.log(summary('agent-call-gate', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
