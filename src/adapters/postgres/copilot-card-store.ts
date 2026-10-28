import { and, asc, count, eq, gt, gte, sql } from 'drizzle-orm'
import { type CopilotCard, type CopilotCardId, formatId } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceCopilotCards } from 'tula-closeline-db/schema'
import {
  type CopilotCardStore,
  MAX_CARD_PAGE,
  marked,
  type SimilarMomentCard,
} from '~/ports/copilot-card-store'

type Row = typeof voiceCopilotCards.$inferSelect

const toCard = (row: Row): CopilotCard => {
  const base = {
    id: row.id as CopilotCardId,
    callId: row.callId as CopilotCard['callId'],
    sequence: row.sequence,
    evidence: { moments: row.evidenceMoments, deals: row.evidenceDeals },
    citedMoments: row.citedMoments as CopilotCard['citedMoments'],
    quotes: row.quotes as CopilotCard['quotes'],
    shownAt: row.shownAt.toISOString(),
    rating: row.rating as CopilotCard['rating'],
    dismissed: row.dismissed,
    pinned: row.pinned,
  }
  switch (row.kind) {
    case 'objection':
      return {
        ...base,
        kind: 'objection',
        objectionType: row.objectionType as never,
        response: row.response as string,
      }
    case 'next_step':
      return { ...base, kind: 'next_step', nextStep: row.nextStep as string }
    case 'document':
      return {
        ...base,
        kind: 'document',
        source: {
          documentId: row.documentId as never,
          page: row.documentPage,
          passage: row.documentPassage as string,
        },
      }
    default:
      return { ...base, kind: 'similar_moment' }
  }
}

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
            kind: card.source ? 'document' : 'similar_moment',
            documentId: card.source?.documentId,
            documentPage: card.source?.page,
            documentPassage: card.source?.passage,
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
    async upgrade(organizationId, callId, cardId, composed) {
      return withOrganization(db, organizationId, async (tx) => {
        const [row] = await tx
          .update(voiceCopilotCards)
          .set({
            kind: composed.kind,
            objectionType: composed.kind === 'objection' ? composed.objectionType : null,
            response: composed.kind === 'objection' ? composed.response : null,
            nextStep: composed.kind === 'next_step' ? composed.nextStep : null,
            citedMoments: composed.citedMoments,
            quotes: composed.quotes,
          })
          .where(
            and(
              eq(voiceCopilotCards.organizationId, organizationId),
              eq(voiceCopilotCards.callId, callId),
              eq(voiceCopilotCards.id, cardId),
              eq(voiceCopilotCards.kind, 'similar_moment')
            )
          )
          .returning()
        return row === undefined ? undefined : toCard(row)
      })
    },
    async mark(organizationId, callId, cardId, mark) {
      return withOrganization(db, organizationId, async (tx) => {
        // Locked, so two identical requests at once change the card once and only one says so.
        const [row] = await tx
          .select()
          .from(voiceCopilotCards)
          .where(
            and(
              eq(voiceCopilotCards.organizationId, organizationId),
              eq(voiceCopilotCards.callId, callId),
              eq(voiceCopilotCards.id, cardId)
            )
          )
          .for('update')
        if (row === undefined) {
          return undefined
        }
        const next = marked(toCard(row), mark)
        if (
          next.rating === row.rating &&
          next.dismissed === row.dismissed &&
          next.pinned === row.pinned
        ) {
          return { card: toCard(row), changed: false, updatedAt: row.updatedAt }
        }
        const [updated] = await tx
          .update(voiceCopilotCards)
          .set({ ...next, updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)) })
          .where(
            and(
              eq(voiceCopilotCards.organizationId, organizationId),
              eq(voiceCopilotCards.callId, callId),
              eq(voiceCopilotCards.id, cardId)
            )
          )
          .returning()
        return updated === undefined
          ? undefined
          : { card: toCard(updated), changed: true, updatedAt: updated.updatedAt }
      })
    },
    async list(organizationId, callId, afterSequence, limit, kind) {
      const size = Math.min(Math.max(limit, 1), MAX_CARD_PAGE)
      return withOrganization(db, organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(voiceCopilotCards)
          .where(
            and(
              eq(voiceCopilotCards.organizationId, organizationId),
              eq(voiceCopilotCards.callId, callId),
              gt(voiceCopilotCards.sequence, afterSequence),
              kind === undefined ? undefined : eq(voiceCopilotCards.kind, kind)
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
