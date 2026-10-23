import type { UserId } from 'tula-closeline-contract'

/** Names one stored answer: the caller, the route's short name and the client's `Idempotency-Key`. */
export type IdempotencyKeyRef = {
  userId: UserId
  /** A fixed short name per route, such as `lines.add`: 1 to 64 of `a-z`, `0-9`, `.`, `_`. */
  route: string
  key: string
}

/** What {@link IdempotencyScope.reserve} needs to claim a key. */
export type IdempotencyReservationRequest = IdempotencyKeyRef & {
  /** The SHA-256 of the canonical request as 64 lowercase hex characters; the request itself is never stored. */
  requestHash: string
  now: Date
  /** A stored answer created before this has expired and counts as absent. */
  expiredBefore: Date
}

/** What claiming an idempotency key found. */
export type IdempotencyReservation =
  /** The key was free: the row is in this transaction, in flight, and must be completed or released before commit. */
  | { outcome: 'reserved' }
  /** The same request was answered before: the stored status and body. */
  | { outcome: 'replay'; status: number; response: unknown }
  /** The key was used for a different request. */
  | { outcome: 'reused' }

/**
 * One Organization's idempotency keys inside one transaction. It can reach that Organization's rows
 * only. The transaction is also where the write the key protects belongs, so a key is stored if and
 * only if its write is.
 */
export type IdempotencyScope = {
  /**
   * Claims a key for this transaction: inserts the row in flight (no status, no response). Where
   * the key already has a stored answer that has not expired, nothing is inserted and the answer is
   * returned: `replay` for the same request, `reused` for a different one. An expired answer is
   * replaced. While another transaction holds the key this waits for it, no longer than the
   * adapter's wait, then throws {@link IdempotencyInProgressError}.
   */
  reserve: (request: IdempotencyReservationRequest) => Promise<IdempotencyReservation>
  /** Completes the in-flight row this transaction reserved. Throws when the key is not in flight. */
  complete: (ref: IdempotencyKeyRef, status: number, response: unknown) => Promise<void>
  /** Removes a key, reserved here or completed earlier, so the same key can be used again. */
  remove: (ref: IdempotencyKeyRef) => Promise<boolean>
  /**
   * Removes at most `limit` of this Organization's keys created before `before`, oldest first, in
   * one statement, and returns how many went. A row another transaction holds is skipped. If it
   * throws, the transaction is still usable.
   */
  purge: (before: Date, limit: number) => Promise<number>
}

/** Where the stored answers of idempotent requests are kept, one transaction per Organization at a time. */
export type IdempotencyStore = {
  /** Runs `fn` in one transaction scoped to the Organization: it commits when `fn` resolves and rolls back when it throws. */
  withOrganization: <T>(
    organizationId: string,
    fn: (scope: IdempotencyScope) => Promise<T>
  ) => Promise<T>
}

/**
 * The idempotency key is held by another transaction that has neither committed nor rolled back
 * within the wait. Nothing changed; the client tries again after `retryAfterSeconds`.
 */
export class IdempotencyInProgressError extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super('An earlier request with this idempotency key is still running')
    this.name = 'IdempotencyInProgressError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}
