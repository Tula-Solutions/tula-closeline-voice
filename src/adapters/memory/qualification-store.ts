import type { QualificationStore, StoredAnswer } from '~/ports/qualification-store'

/** The in-memory store plus what a test seeds and reads. */
export type MemoryQualificationStore = QualificationStore & {
  /** Makes `inquiryId` the Inquiry of the Call. */
  linkCall: (organizationId: string, callId: string, inquiryId: string) => void
  /** The summary stored on the Inquiry, or `undefined`. */
  summaryOf: (organizationId: string, inquiryId: string) => string | undefined
}

/** An in-memory {@link QualificationStore} for tests and local runs. */
export function createMemoryQualificationStore(): MemoryQualificationStore {
  const inquiries = new Map<string, string>()
  const answers = new Map<string, Map<string, StoredAnswer>>()
  const summaries = new Map<string, string>()
  const key = (...parts: string[]) => parts.join('\u0000')
  return {
    linkCall: (org, callId, inquiryId) => void inquiries.set(key(org, callId), inquiryId),
    summaryOf: (org, inquiryId) => summaries.get(key(org, inquiryId)),
    async inquiryOfCall(org, callId) {
      return inquiries.get(key(org, callId))
    },
    async answers(org, inquiryId) {
      return structuredClone([...(answers.get(key(org, inquiryId))?.values() ?? [])])
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
