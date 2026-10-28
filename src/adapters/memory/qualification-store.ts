import type { QualificationStore, StoredAnswer } from '~/ports/qualification-store'

/** The in-memory store plus what a test seeds and reads. */
export type MemoryQualificationStore = QualificationStore & {
  /** Makes `inquiryId` the Inquiry of the Call. */
  linkCall: (organizationId: string, callId: string, inquiryId: string, prospectId?: string) => void
  /** The summary stored on the Inquiry, or `undefined`. */
  summaryOf: (organizationId: string, inquiryId: string) => string | undefined
}

/** An in-memory {@link QualificationStore} for tests and local runs. */
export function createMemoryQualificationStore(): MemoryQualificationStore {
  const inquiries = new Map<string, string>()
  const answers = new Map<string, Map<string, StoredAnswer>>()
  const prospects = new Map<string, string>()
  const summaries = new Map<string, string>()
  const key = (...parts: string[]) => parts.join('\u0000')
  return {
    linkCall: (org, callId, inquiryId, prospectId = 'prs_unset') => {
      inquiries.set(key(org, callId), inquiryId)
      prospects.set(key(org, inquiryId), prospectId)
    },
    summaryOf: (org, inquiryId) => summaries.get(key(org, inquiryId)),
    async inquiryOfCall(org, callId) {
      return inquiries.get(key(org, callId))
    },
    async answers(org, inquiryId) {
      return structuredClone([...(answers.get(key(org, inquiryId))?.values() ?? [])])
    },
    async details(org, inquiryId) {
      const prospectId = prospects.get(key(org, inquiryId))
      return prospectId === undefined
        ? undefined
        : { prospectId, summary: summaries.get(key(org, inquiryId)) ?? null }
    },
    async record(org, inquiryId, answer) {
      const own = answers.get(key(org, inquiryId)) ?? new Map<string, StoredAnswer>()
      own.set(answer.questionId, { ...answer })
      answers.set(key(org, inquiryId), own)
    },
    async setSummary(org, inquiryId, summary) {
      summaries.set(key(org, inquiryId), summary)
    },
  }
}
