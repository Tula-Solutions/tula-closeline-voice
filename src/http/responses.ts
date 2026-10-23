import {
  errorBodySchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

/** Describes a failure response in a route's OpenAPI definition with the contract's error body. */
export function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: errorBodySchema } },
  }
}

/**
 * Describes a failure that also sends `Retry-After`: `request.idempotency_in_progress` with its
 * `details.retryAfter`.
 */
export function errorResponseWithRetryAfter(description: string) {
  return {
    ...errorResponse(description),
    headers: z.object({
      'Retry-After': z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .meta({ description: 'Whole seconds to wait before trying again.' }),
    }),
  }
}

/**
 * The optional `Idempotency-Key` header of a `POST` with effects (16 to 128 characters from
 * `A-Za-z0-9_.:-`), described in `description`: a route says what a repeated key does for it.
 */
export function optionalIdempotencyKeyHeader(description: string) {
  return z.object({
    [IDEMPOTENCY_KEY_HEADER.toLowerCase()]: idempotencyKeySchema.optional().meta({ description }),
  })
}
