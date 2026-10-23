import type { Line, LineAssignment, LineState, lineCursorSchema } from 'tula-closeline-contract'
import type { z } from 'zod'
import type { IdempotencyScope } from '~/ports/idempotency-store'

/** The position after which the next page of Lines starts. */
export type LineCursor = z.infer<typeof lineCursorSchema>

/** A Line as stored: the contract's Line plus the provider's id for the number, never returned. */
export type StoredLine = Line & { providerSid: string | null }

/** What the store needs to create a Line. */
export type NewLine = {
  id: Line['id']
  number: string
  country: string
  label: string | null
  state: Exclude<LineState, 'released'>
  providerSid: string | null
  createdAt: Date
}

/** A page request: the rows after `cursor` (newest first), at most `limit`, in one `state`. */
export type LineListQuery = {
  cursor?: LineCursor
  limit: number
  state?: LineState
}

/** Thrown by {@link LineStore.insert} when the number is live in some Organization already. */
export class NumberTakenError extends Error {
  constructor() {
    super('the number is already live on a Line')
    this.name = 'NumberTakenError'
  }
}

/**
 * Where an Organization's Lines are kept. Every method takes the Organization first and can reach
 * that Organization's rows only: another Organization's Line is `undefined`, never an error.
 */
export type LineStore = {
  /**
   * Creates a Line, unassigned; rejects with {@link NumberTakenError} when the number is live.
   * With `within`, the insert joins that idempotency transaction, so the Line and its key commit
   * or roll back together.
   */
  insert: (organizationId: string, line: NewLine, within?: IdempotencyScope) => Promise<StoredLine>
  /** The Lines after the cursor, newest first by `(createdAt, id)`, at most `limit`. */
  list: (organizationId: string, query: LineListQuery) => Promise<StoredLine[]>
  /** One Line, or `undefined` when this Organization has none with that id. */
  get: (organizationId: string, id: Line['id']) => Promise<StoredLine | undefined>
  /** Sets the assignment of a Line that is not released; `undefined` when missing or released. */
  assign: (
    organizationId: string,
    id: Line['id'],
    assignment: LineAssignment
  ) => Promise<StoredLine | undefined>
  /** Releases a Line and clears its assignment; `undefined` when missing, the Line as is if released. */
  release: (organizationId: string, id: Line['id'], at: Date) => Promise<StoredLine | undefined>
  /** Forgets the provider id of a released Line once the number is back with the provider. */
  clearProviderSid: (organizationId: string, id: Line['id']) => Promise<void>
}
