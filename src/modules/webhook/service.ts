import { callIdSchema, ERRORS, organizationIdSchema } from 'tula-closeline-contract'
import { AppError, MAX_WEBHOOK_BODY_BYTES } from 'tula-closeline-kit'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { mapRecordingCallback, mapStatusCallback } from './mapping'

/** What the webhook service needs from the container. */
export type WebhookDeps = Pick<Container, 'telephony' | 'callEvents' | 'clock' | 'logger' | 'env'>

/** Which of the provider's callbacks arrived. */
export type CallbackKind = 'status' | 'recording'

/** A callback exactly as it arrived; the body is untrusted until its signature has been checked. */
export type RawCallback = {
  /** The path and query as the provider requested them, which its signature covers. */
  pathAndQuery: string
  /** The raw form body, unparsed: the signature covers these exact bytes. */
  body: string
  signature: string | undefined
  /** The provider's retry-stable token for this delivery, when it sends one. */
}

/** What the callback did: it changed the Call log, it had been seen already, or it needs nothing. */
export type CallbackOutcome = 'recorded' | 'duplicate' | 'ignored'

const callbackQuerySchema = z.strictObject({
  organizationId: organizationIdSchema,
  callId: callIdSchema,
})

/** Whether the body is longer than the limit, counted in bytes. */
export function isOversize(body: string): boolean {
  if (body.length > MAX_WEBHOOK_BODY_BYTES) {
    return true
  }
  // A character is at most three bytes in UTF-16, so a short enough string needs no encoding.
  return (
    body.length * 3 > MAX_WEBHOOK_BODY_BYTES &&
    new TextEncoder().encode(body).length > MAX_WEBHOOK_BODY_BYTES
  )
}

/**
 * Handles one provider callback. The signature is checked first, over the URL the provider was
 * given, so an unsigned request reaches neither the parser nor the store. The Call log is then
 * appended to once per provider event id, so a redelivery changes nothing.
 */
export async function receive(
  deps: WebhookDeps,
  kind: CallbackKind,
  callback: RawCallback
): Promise<CallbackOutcome> {
  if (isOversize(callback.body)) {
    throw domainError(ERRORS['request.too_large'])
  }
  // The signed URL is the one the provider was configured with, not the Host header of a request
  // that came through a load balancer.
  const url = `${deps.env.WEBHOOK_BASE_URL ?? 'http://localhost'}${callback.pathAndQuery}`
  if (!deps.telephony.verifyWebhook({ url, body: callback.body, signature: callback.signature })) {
    // Only the kind is logged: the body holds phone numbers and the signature is a credential.
    deps.logger.warn('webhook refused: bad signature', { callback: kind })
    throw domainError(ERRORS['auth.forbidden'])
  }

  const query = callbackQuerySchema.safeParse(
    Object.fromEntries(new URL(url).searchParams.entries())
  )
  if (!query.success) {
    throw domainError(ERRORS['request.invalid'])
  }
  const form = new URLSearchParams(callback.body)
  const now = deps.clock.now()
  const mapped = (kind === 'status' ? mapStatusCallback : mapRecordingCallback)(form, now)
  if (mapped.kind === 'invalid') {
    throw domainError(ERRORS['request.invalid'])
  }
  if (mapped.kind === 'ignored') {
    return 'ignored'
  }

  const result = await deps.callEvents.recordProviderCallback({
    organizationId: query.data.organizationId,
    callId: query.data.callId,
    providerEventId: mapped.eventId,
    occurredAt: mapped.at,
  })
  if (result === 'unknown_call') {
    throw new AppError({
      code: ERRORS['request.invalid'].code,
      status: 404,
      message: 'The Call was not found.',
    })
  }
  return result
}
