import { type CallId, ERRORS } from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { callTurnsResponseSchema } from './schema'

/**
 * The turns of one Call within `window` of turn `around`, for the Organization that owns it. A
 * Call of another Organization, a missing Call and a missing turn are all `request.not_found`.
 */
export async function readWindow(
  deps: Pick<Container, 'calls' | 'turns'>,
  input: { organizationId: string; callId: CallId; around: number; window: number }
): Promise<z.infer<typeof callTurnsResponseSchema>> {
  const { organizationId, callId, around, window } = input
  const call = await deps.calls.get(organizationId, callId)
  if (call === undefined) {
    throw domainError(ERRORS['request.not_found'])
  }
  const turns = await deps.turns.range(
    organizationId,
    { kind: 'call', id: callId },
    Math.max(0, around - window),
    around + window
  )
  if (!turns.some((turn) => turn.index === around)) {
    throw domainError(ERRORS['request.not_found'])
  }
  return {
    around,
    turns: turns.map(({ index, role, text }) => ({ index, role, text })),
  }
}
