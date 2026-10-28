import { and, eq } from 'drizzle-orm'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceInquiries, voiceQualificationAnswers } from 'tula-closeline-db/schema'
import type { QualificationStore } from '~/ports/qualification-store'

/** The Postgres {@link QualificationStore}: every statement runs inside `withOrganization`. */
export function createPostgresQualificationStore(db: Database): QualificationStore {
  return {
    async inquiryOfCall(organizationId, callId) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .select({ id: voiceInquiries.id })
          .from(voiceInquiries)
          .where(
            and(
              eq(voiceInquiries.organizationId, organizationId),
              eq(voiceInquiries.callId, callId)
            )
          )
          .limit(1)
      )
      return row?.id
    },

    async answers(organizationId, inquiryId) {
      const rows = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceQualificationAnswers)
          .where(
            and(
              eq(voiceQualificationAnswers.organizationId, organizationId),
              eq(voiceQualificationAnswers.inquiryId, inquiryId)
            )
          )
          .limit(100)
      )
      return rows.map((row) => ({
        questionId: row.questionId,
        value: row.value ?? null,
        skipped: row.skipped,
      }))
    },

    async details(organizationId, inquiryId) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .select({
            prospectId: voiceInquiries.prospectId,
            summary: voiceInquiries.qualificationSummary,
          })
          .from(voiceInquiries)
          .where(
            and(eq(voiceInquiries.organizationId, organizationId), eq(voiceInquiries.id, inquiryId))
          )
          .limit(1)
      )
      return row === undefined
        ? undefined
        : { prospectId: row.prospectId, summary: row.summary ?? null }
    },

    async record(organizationId, inquiryId, answer) {
      await withOrganization(db, organizationId, (tx) =>
        tx
          .insert(voiceQualificationAnswers)
          .values({
            organizationId,
            inquiryId,
            questionId: answer.questionId,
            value: answer.value,
            skipped: answer.skipped,
          })
          .onConflictDoUpdate({
            target: [
              voiceQualificationAnswers.organizationId,
              voiceQualificationAnswers.inquiryId,
              voiceQualificationAnswers.questionId,
            ],
            set: { value: answer.value, skipped: answer.skipped, answeredAt: new Date() },
          })
      )
    },

    async setSummary(organizationId, inquiryId, summary) {
      await withOrganization(db, organizationId, (tx) =>
        tx
          .update(voiceInquiries)
          .set({ qualificationSummary: summary, updatedAt: new Date() })
          .where(
            and(eq(voiceInquiries.organizationId, organizationId), eq(voiceInquiries.id, inquiryId))
          )
      )
    },
  }
}
