import {
  copilotCardSchema,
  DEFAULT_COPILOT_MIN_DEALS,
  DEFAULT_COPILOT_MIN_MOMENTS,
  formatId,
  MAX_COPILOT_CARDS_PER_CALL,
  type SearchTurn,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import type { MomentSearch } from '~/ports/evidence-search'

/** What the retrieval cards need from the container. */
export type CardDeps = Pick<Container, 'copilotCards' | 'evidence' | 'copilot' | 'clock' | 'logger'>

/** The least time between two cards on a Call, in milliseconds. */
export const MIN_CARD_GAP_MS = 8_000
/** How long a Moment, once cited, is not cited again on the same Call, in milliseconds. */
export const REPEAT_WINDOW_MS = 60_000
/** The most Moments one search asks for. */
const SEARCH_LIMIT = 5

/** Whether the throttle and the cap let a card be shown now, and which Moments were shown lately. */
async function room(deps: CardDeps, organizationId: string, callId: string) {
  const now = deps.clock.now().getTime()
  const tally = await deps.copilotCards.tally(
    organizationId,
    callId,
    new Date(now - REPEAT_WINDOW_MS)
  )
  const newest = Math.max(0, ...tally.recent.map((card) => card.shownAt.getTime()))
  const open =
    tally.count < MAX_COPILOT_CARDS_PER_CALL && (newest === 0 || now - newest >= MIN_CARD_GAP_MS)
  // shortcut: a Moment is identified by its Call, as cards cite the Call and Deal and not the
  // Moment's index; two Moments of one Call count as one. Add the index when the contract does.
  const shown = new Set(tally.recent.flatMap((card) => card.citedMoments.map((m) => m.callId)))
  return { open, shown }
}

/** Runs the Moment search under the card timeout; a late answer is ignored and never throws. */
async function search(
  deps: CardDeps,
  organizationId: string,
  window: SearchTurn[]
): Promise<MomentSearch> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('card search timed out'))
    }, deps.copilot.cardSearchTimeoutMs)
  })
  const found = deps.evidence.searchMoments(organizationId, window, SEARCH_LIMIT, controller.signal)
  found.catch(() => undefined)
  try {
    return await Promise.race([found, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Looks for a retrieval card after a final Prospect turn: the Playbook's won-Deal Moments that
 * resemble the last turns, shown only when its own evidence meets the minimum. No model call. It
 * never throws and never touches the Call: a failed or slow search, a stale answer, the throttle
 * (one card per 8 s, at most 60 per Call) and a Moment shown in the last 60 s each mean no card.
 * `isStale` says whether a newer turn has started its own search. The text of a card is tenant
 * text, so only the Call and an error code are logged.
 */
export async function onProspectTurn(
  deps: CardDeps,
  organizationId: string,
  callId: string,
  window: SearchTurn[],
  isStale: () => boolean
): Promise<void> {
  try {
    if (!(await room(deps, organizationId, callId)).open) {
      return
    }
    const found = await search(deps, organizationId, window)
    if (isStale()) {
      return
    }
    const { open, shown } = await room(deps, organizationId, callId)
    if (!open) {
      return
    }
    const seen = new Set<string>()
    const items = found.items
      .filter((item) => !shown.has(item.callId) && !seen.has(item.callId) && seen.add(item.callId))
      .slice(0, SEARCH_LIMIT)
    // The minimum is the Playbook's own count, over all the Moments it found, not the few shown.
    if (
      items.length === 0 ||
      found.evidence.moments < DEFAULT_COPILOT_MIN_MOMENTS ||
      found.evidence.deals < DEFAULT_COPILOT_MIN_DEALS
    ) {
      return
    }
    const card = {
      evidence: found.evidence,
      citedMoments: items.map(({ callId: from, dealRecordId }) => ({
        callId: from,
        dealRecordId,
      })),
      quotes: items.map(({ callId: from, dealRecordId, prospect, repNext }) => ({
        callId: from,
        dealRecordId,
        prospect,
        repNext,
      })),
      shownAt: deps.clock.now(),
    }
    const valid = copilotCardSchema.safeParse({
      ...card,
      kind: 'similar_moment',
      id: formatId('ccard', crypto.randomUUID()),
      callId,
      sequence: 1,
      shownAt: card.shownAt.toISOString(),
      rating: null,
      dismissed: false,
      pinned: false,
    })
    if (!valid.success) {
      return
    }
    await deps.copilotCards.append(organizationId, callId, card)
  } catch (error) {
    deps.logger.warn('cards.skipped', { callId, code: (error as { code?: unknown }).code })
  }
}
