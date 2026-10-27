import type { QualificationQuestion } from 'tula-closeline-contract'
import type { QualificationQuestionStore } from '~/ports/qualification-question-store'

/** An in-memory {@link QualificationQuestionStore} for tests and local runs. */
export function createMemoryQualificationQuestionStore(): QualificationQuestionStore {
  const byOrganization = new Map<string, QualificationQuestion[]>()
  const ordered = (organizationId: string): QualificationQuestion[] =>
    structuredClone(byOrganization.get(organizationId) ?? []).sort(
      (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)
    )

  return {
    async list(organizationId, query) {
      return ordered(organizationId)
        .filter(
          (q) =>
            query.cursor === undefined ||
            q.position > query.cursor.position ||
            (q.position === query.cursor.position && q.id > query.cursor.id)
        )
        .slice(0, query.limit)
    },
    async get(organizationId, id) {
      return ordered(organizationId).find((q) => q.id === id)
    },
    async change(organizationId, change) {
      const { next, result } = change(ordered(organizationId))
      byOrganization.set(organizationId, structuredClone(next))
      return result
    },
  }
}
