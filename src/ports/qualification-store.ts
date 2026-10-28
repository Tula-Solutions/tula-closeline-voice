/** What a Qualification answer holds: text, a number or a yes or no; `null` when the question was skipped. */
export type AnswerValue = string | number | boolean | null

/** One stored answer of an Inquiry's Qualification. */
export type StoredAnswer = { questionId: string; value: AnswerValue; skipped: boolean }

/**
 * Where the Agent keeps what a Prospect answered and the summary of it. Every method takes the
 * Organization first and reaches that Organization's rows only.
 */
export type QualificationStore = {
  /** The Inquiry the Call belongs to, or `undefined` when none was made for it. */
  inquiryOfCall: (organizationId: string, callId: string) => Promise<string | undefined>
  /** Every answer of the Inquiry (an Organization has at most 50 questions). */
  answers: (organizationId: string, inquiryId: string) => Promise<StoredAnswer[]>
  /** The Inquiry's Prospect and the summary stored on it (`null` when it has none). */
  details: (
    organizationId: string,
    inquiryId: string
  ) => Promise<{ prospectId: string; summary: string | null } | undefined>
  /** Stores the answer, replacing an earlier one to the same question. Idempotent. */
  record: (organizationId: string, inquiryId: string, answer: StoredAnswer) => Promise<void>
  /** Stores the summary on the Inquiry, replacing an earlier one. */
  setSummary: (organizationId: string, inquiryId: string, summary: string) => Promise<void>
}
