import { and, asc, eq, sql } from 'drizzle-orm'
import { type QualificationQuestion, qualificationQuestionSchema } from 'tula-closeline-contract'
import { type Database, type Transaction, withOrganization } from 'tula-closeline-db'
import { voiceQualificationQuestions } from 'tula-closeline-db/schema'
import { transactionOf } from '~/adapters/postgres/idempotency-store'
import type { QualificationQuestionStore } from '~/ports/qualification-question-store'

type Row = typeof voiceQualificationQuestions.$inferSelect

/** Reads a row through the contract's schema, so a row that breaks the contract fails loudly. */
function toQuestion(row: Row): QualificationQuestion {
  return qualificationQuestionSchema.parse({
    id: row.id,
    position: row.position,
    prompt: row.prompt,
    kind: row.kind,
    choices: row.choices,
    required: row.required,
    skipWhen: row.skipWhen,
  })
}

const sameContent = (a: QualificationQuestion, b: QualificationQuestion): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/**
 * The Postgres {@link QualificationQuestionStore}: every statement runs inside `withOrganization`
 * (row-level security on top of the explicit filter), and a change takes a per-Organization
 * advisory lock so two concurrent changes to the list run one after the other.
 */
export function createPostgresQualificationQuestionStore(db: Database): QualificationQuestionStore {
  const inOrganization = (organizationId: string) =>
    eq(voiceQualificationQuestions.organizationId, organizationId)

  return {
    async list(organizationId, query) {
      const rows = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceQualificationQuestions)
          .where(
            and(
              inOrganization(organizationId),
              query.cursor === undefined
                ? undefined
                : sql`(${voiceQualificationQuestions.position}, ${voiceQualificationQuestions.id}) > (${query.cursor.position}, ${query.cursor.id})`
            )
          )
          .orderBy(asc(voiceQualificationQuestions.position), asc(voiceQualificationQuestions.id))
          .limit(query.limit)
      )
      return rows.map(toQuestion)
    },

    async get(organizationId, id) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceQualificationQuestions)
          .where(and(inOrganization(organizationId), eq(voiceQualificationQuestions.id, id)))
          .limit(1)
      )
      return row === undefined ? undefined : toQuestion(row)
    },

    async change(organizationId, change, within) {
      const run = async (tx: Transaction) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`voice.qualification_questions:${organizationId}`}, 0))`
        )
        const rows = await tx
          .select()
          .from(voiceQualificationQuestions)
          .where(inOrganization(organizationId))
          .orderBy(asc(voiceQualificationQuestions.position), asc(voiceQualificationQuestions.id))
        const current = rows.map(toQuestion)
        const { next, result } = change(current)
        const before = new Map(current.map((q) => [q.id, q]))
        const keep = new Set(next.map((q) => q.id))
        for (const gone of current.filter((q) => !keep.has(q.id))) {
          await tx
            .delete(voiceQualificationQuestions)
            .where(and(inOrganization(organizationId), eq(voiceQualificationQuestions.id, gone.id)))
        }
        for (const question of next) {
          const existing = before.get(question.id)
          if (existing !== undefined && sameContent(existing, question)) {
            continue
          }
          const values = {
            position: question.position,
            prompt: question.prompt,
            kind: question.kind,
            choices: question.choices,
            required: question.required,
            skipWhen: question.skipWhen,
          }
          if (existing === undefined) {
            await tx
              .insert(voiceQualificationQuestions)
              .values({ id: question.id, organizationId, ...values })
          } else {
            await tx
              .update(voiceQualificationQuestions)
              .set({ ...values, updatedAt: sql`now()` })
              .where(
                and(inOrganization(organizationId), eq(voiceQualificationQuestions.id, question.id))
              )
          }
        }
        return result
      }
      const joined = within === undefined ? undefined : transactionOf(within)
      return joined === undefined ? withOrganization(db, organizationId, run) : run(joined)
    },
  }
}
