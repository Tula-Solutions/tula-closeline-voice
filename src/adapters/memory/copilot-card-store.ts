import { type CopilotCard, type CopilotCardId, formatId } from 'tula-closeline-contract'
import { type CopilotCardStore, MAX_CARD_PAGE } from '~/ports/copilot-card-store'

/** An in-memory {@link CopilotCardStore} for tests and local runs. */
export function createMemoryCopilotCardStore(): CopilotCardStore {
  const byCall = new Map<string, CopilotCard[]>()
  const keyOf = (organizationId: string, callId: string) => `${organizationId}\u0000${callId}`
  return {
    async append(organizationId, callId, card) {
      const cards = byCall.get(keyOf(organizationId, callId)) ?? []
      byCall.set(keyOf(organizationId, callId), cards)
      const base = {
        id: formatId('ccard', crypto.randomUUID()) as CopilotCardId,
        callId: callId as CopilotCard['callId'],
        sequence: cards.length + 1,
        evidence: card.evidence,
        citedMoments: card.citedMoments,
        quotes: card.quotes,
        shownAt: card.shownAt.toISOString(),
        rating: null,
        dismissed: false,
        pinned: false,
      }
      const stored: CopilotCard = card.source
        ? { ...base, kind: 'document', source: card.source }
        : { ...base, kind: 'similar_moment' }
      cards.push(stored)
      return structuredClone(stored)
    },
    async upgrade(organizationId, callId, cardId, composed) {
      const cards = byCall.get(keyOf(organizationId, callId)) ?? []
      const at = cards.findIndex((card) => card.id === cardId && card.kind === 'similar_moment')
      const old = cards[at]
      if (old === undefined) {
        return undefined
      }
      const { kind: _kind, ...rest } = old
      const upgraded = { ...rest, ...structuredClone(composed) } as CopilotCard
      cards[at] = upgraded
      return structuredClone(upgraded)
    },
    async list(organizationId, callId, afterSequence, limit) {
      const size = Math.min(Math.max(limit, 1), MAX_CARD_PAGE)
      return structuredClone(
        (byCall.get(keyOf(organizationId, callId)) ?? [])
          .filter((card) => card.sequence > afterSequence)
          .slice(0, size)
      )
    },
    async tally(organizationId, callId, since) {
      const cards = byCall.get(keyOf(organizationId, callId)) ?? []
      return {
        count: cards.length,
        recent: cards
          .filter((card) => Date.parse(card.shownAt) >= since.getTime())
          .map((card) => ({
            shownAt: new Date(card.shownAt),
            citedMoments: structuredClone(card.citedMoments),
          })),
      }
    },
  }
}
