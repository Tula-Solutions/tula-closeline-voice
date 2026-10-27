import type { QualificationQuestion } from 'tula-closeline-contract'
import type { IdempotencyScope } from '~/ports/idempotency-store'

/** The position after which the next page of questions starts. */
export type QuestionCursor = { position: number; id: QualificationQuestion['id'] }

/** A page request: the questions after `cursor` in position order, at most `limit`. */
export type QuestionListQuery = { cursor?: QuestionCursor; limit: number }

/**
 * A change to the whole ordered list of an Organization's questions: the list the store should hold
 * afterwards (positions 1..n in order) and what the caller wants back.
 */
export type QuestionChange<T> = { next: QualificationQuestion[]; result: T }

/**
 * Where an Organization's Qualification questions are kept. Every method takes the Organization
 * first and reaches that Organization's rows only: another Organization's question is `undefined`.
 */
export type QualificationQuestionStore = {
  /** The questions after the cursor in `(position, id)` order, at most `limit`. */
  list: (organizationId: string, query: QuestionListQuery) => Promise<QualificationQuestion[]>
  /** One question, or `undefined` when this Organization has none with that id. */
  get: (
    organizationId: string,
    id: QualificationQuestion['id']
  ) => Promise<QualificationQuestion | undefined>
  /**
   * Reads the whole ordered list, lets `change` decide the new list, and stores it, as one atomic
   * step per Organization: two concurrent changes never see each other's half-done list. `change`
   * is synchronous and may throw to abandon the change. With `within`, the step joins that
   * idempotency transaction.
   */
  change: <T>(
    organizationId: string,
    change: (current: QualificationQuestion[]) => QuestionChange<T>,
    within?: IdempotencyScope
  ) => Promise<T>
}
