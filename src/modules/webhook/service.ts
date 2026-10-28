import { callIdSchema, ERRORS, organizationIdSchema, VOICE_ERRORS } from 'tula-closeline-contract'
import { MAX_WEBHOOK_BODY_BYTES } from 'tula-closeline-kit'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as AgentCallDial from '~/modules/agent-call-dial/service'
import type { CallDeps } from '~/modules/call/service'
import * as Calls from '~/modules/call/service'
import { enqueueFinish } from '~/modules/recording/jobs'
import { mapDetectionCallback, mapRecordingCallback, mapStatusCallback } from './mapping'

/** What the webhook service needs from the container. */
export type WebhookDeps = Pick<
  Container,
  'telephony' | 'callEvents' | 'clock' | 'logger' | 'env' | 'jobs'
> &
  CallDeps &
  AgentCallDial.DialDeps

/** Which of the provider's callbacks arrived. */
export type CallbackKind = 'status' | 'recording' | 'detection'

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
 * Checks size and signature of a callback and returns the URL the signature covers. The signed URL
 * is the one the provider was configured with, not the Host header of a request that came through
 * a load balancer.
 */
function verified(deps: WebhookDeps, kind: string, callback: RawCallback): string {
  if (isOversize(callback.body)) {
    throw domainError(ERRORS['request.too_large'])
  }
  const url = `${deps.env.WEBHOOK_BASE_URL ?? 'http://localhost'}${callback.pathAndQuery}`
  if (!deps.telephony.verifyWebhook({ url, body: callback.body, signature: callback.signature })) {
    // Only the kind is logged: the body holds phone numbers and the signature is a credential.
    deps.logger.warn('webhook refused: bad signature', { callback: kind })
    throw domainError(ERRORS['auth.forbidden'])
  }
  return url
}

const inboundFormSchema = z.object({
  CallSid: z.string().min(1).max(64),
  From: z.string().min(1).max(32),
  To: z.string().min(1).max(32),
})

/**
 * Handles the provider's notice that a Prospect is calling one of our numbers. The signature is
 * checked first. A number that is no active Line is ignored (a retired Line gets no ring); any
 * other notice rings the Line's Reps once, however often the provider retries it.
 */
export async function receiveInbound(
  deps: WebhookDeps,
  callback: RawCallback
): Promise<Awaited<ReturnType<typeof Calls.ringInbound>> | 'ignored'> {
  verified(deps, 'inbound', callback)
  const form = inboundFormSchema.safeParse(Object.fromEntries(new URLSearchParams(callback.body)))
  if (!form.success) {
    throw domainError(ERRORS['request.invalid'])
  }
  const found = await deps.lines.byNumber(form.data.To)
  if (found === undefined) {
    return 'ignored'
  }
  return Calls.ringInbound(deps, {
    organizationId: found.organizationId as Parameters<
      typeof Calls.ringInbound
    >[1]['organizationId'],
    line: found.line,
    providerCallSid: form.data.CallSid,
    callerNumber: form.data.From,
  })
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
  const url = verified(deps, kind, callback)

  const query = callbackQuerySchema.safeParse(
    Object.fromEntries(new URL(url).searchParams.entries())
  )
  if (!query.success) {
    throw domainError(ERRORS['request.invalid'])
  }
  const form = new URLSearchParams(callback.body)
  const now = deps.clock.now()
  const mappers = {
    status: mapStatusCallback,
    recording: mapRecordingCallback,
    detection: mapDetectionCallback,
  }
  const mapped = mappers[kind](form, now)
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
    throw domainError(VOICE_ERRORS['call.provider_call_not_found'])
  }
  const providerCallId = form.get('CallSid')
  const stored = await deps.calls.get(query.data.organizationId, query.data.callId)
  if (stored?.direction === 'outbound' && stored.repMembershipId === null) {
    // An Agent's Call: the dialer decides, not the Rep's setup. Also on a repeat, as below.
    if (kind !== 'recording' && mapped.type !== undefined && providerCallId) {
      await AgentCallDial.onEvent(deps, {
        organizationId: query.data.organizationId,
        callId: query.data.callId,
        providerCallId,
        type: mapped.type,
        ...(mapped.answeredBy ? { answeredBy: mapped.answeredBy } : {}),
      })
    }
  } else if (kind === 'status' && mapped.type !== undefined) {
    // Also on a repeat: the first delivery may have logged the event and then failed to act on it,
    // and acting twice is safe (only the first `ringing` to `connecting` move starts the setup).
    await Calls.onProviderStatus(deps, query.data.organizationId, query.data.callId, mapped.type)
  }
  const recordingSid = form.get('RecordingSid')
  if (kind === 'recording' && recordingSid) {
    // Also on a repeat: the first delivery may have logged the event and then failed to queue the
    // job, and the job is safe to run twice. A failure here is a 500 so the provider retries.
    await enqueueFinish(deps.jobs, query.data.organizationId, query.data.callId, recordingSid)
  }
  return result
}
