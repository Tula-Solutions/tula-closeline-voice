import { and, asc, count, eq, gt, gte, sql } from 'drizzle-orm'
import { type CopilotCardId, formatId } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceCopilotCards } from 'tula-closeline-db/schema'
import {
  type CopilotCardStore,
  MAX_CARD_PAGE,
  type SimilarMomentCard,
} from '~/ports/copilot-card-store'

type Row = typeof voiceCopilotCards.$inferSelect

// shortcut: only `similar_moment` rows exist until the model composer upgrades cards in place;
// widen this mapping when the composer ticket lands.
const toCard = (row: Row): SimilarMomentCard => ({
  kind: 'similar_moment',
  id: row.id as CopilotCardId,
  callId: row.callId as SimilarMomentCard['callId'],
  sequence: row.sequence,
  evidence: { moments: row.evidenceMoments, deals: row.evidenceDeals },
  citedMoments: row.citedMoments as SimilarMomentCard['citedMoments'],
  quotes: row.quotes as SimilarMomentCard['quotes'],
  shownAt: row.shownAt.toISOString(),
  rating: row.rating as SimilarMomentCard['rating'],
  dismissed: row.dismissed,
  pinned: row.pinned,
})

/** A {@link CopilotCardStore} over `voice.copilot_cards`. */
export function createPostgresCopilotCardStore(db: Database): CopilotCardStore {
  return {
    async append(organizationId, callId, card) {
      return withOrganization(db, organizationId, async (tx) => {
        const [row] = await tx
          .insert(voiceCopilotCards)
          .values({
            id: formatId('ccard', crypto.randomUUID()),
            organizationId,
            callId,
            // The next sequence on the Call; two writers racing for it collide on the unique key.
            sequence: sql`(select coalesce(max(c.sequence), 0) + 1 from voice.copilot_cards c where c.organization_id = ${organizationId} and c.call_id = ${callId})`,
            kind: 'similar_moment',
            evidenceMoments: card.evidence.moments,
            evidenceDeals: card.evidence.deals,
            citedMoments: card.citedMoments,
            quotes: card.quotes,
            shownAt: card.shownAt,
          })
          .returning()
        if (row === undefined) {
          throw new Error('copilot card insert returned no row')
        }
        return toCard(row)
      })
    },
    async list(organizationId, callId, afterSequence, limit) {
      const size = Math.min(Math.max(limit, 1), MAX_CARD_PAGE)
      return withOrganization(db, organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(voiceCopilotCards)
          .where(
            and(
              eq(voiceCopilotCards.organizationId, organizationId),
              eq(voiceCopilotCards.callId, callId),
              gt(voiceCopilotCards.sequence, afterSequence)
            )
          )
          .orderBy(asc(voiceCopilotCards.sequence))
          .limit(size)
        return rows.map(toCard)
      })
    },
    async tally(organizationId, callId, since) {
      return withOrganization(db, organizationId, async (tx) => {
        const here = and(
          eq(voiceCopilotCards.organizationId, organizationId),
          eq(voiceCopilotCards.callId, callId)
        )
        const [total] = await tx.select({ n: count() }).from(voiceCopilotCards).where(here)
        const recent = await tx
          .select({
            shownAt: voiceCopilotCards.shownAt,
            citedMoments: voiceCopilotCards.citedMoments,
          })
          .from(voiceCopilotCards)
          .where(and(here, gte(voiceCopilotCards.shownAt, since)))
          .orderBy(asc(voiceCopilotCards.sequence))
          .limit(MAX_CARD_PAGE)
        return {
          count: total?.n ?? 0,
          recent: recent.map((r) => ({
            shownAt: r.shownAt,
            citedMoments: r.citedMoments as SimilarMomentCard['citedMoments'],
          })),
        }
      })
    },
  }
}
