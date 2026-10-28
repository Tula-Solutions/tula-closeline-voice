import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  CHAT_ERRORS,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  organizationIdSchema,
  type PublicChatConsentReceipt,
  type PublicChatConsentRequest,
  publicChatConsentReceiptSchema,
  type publicChatMessagePageSchema,
  publicChatMessageReplySchema,
  type publicStartChatResponseSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

type PublicStartChatResponse = z.infer<typeof publicStartChatResponseSchema>
type PublicChatMessageReply = z.infer<typeof publicChatMessageReplySchema>
type PublicChatMessagePage = z.infer<typeof publicChatMessagePageSchema>

import type { Container } from '~/container'
import { resolveClientAddress } from '~/http/client-address'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { converse } from '~/modules/conversation/engine'
import { idempotent, idempotentOutside } from '~/modules/idempotency/service'
import { CHAT_RATE_WINDOW_MS } from '~/ports/chat-limits'
import type { ChatSite } from '~/ports/chat-sites'
import type { StoredChat } from '~/ports/chat-store'

/** What the Chat service needs from the container. */
export type ChatDeps = Pick<
  Container,
  | 'agentSettings'
  | 'turns'
  | 'evidence'
  | 'llm'
  | 'logger'
  | 'clock'
  | 'env'
  | 'idempotency'
  | 'chats'
  | 'chatLimits'
  | 'chatSites'
  | 'consents'
>

/** What the Chat says first, before the visitor writes: it is an AI, and the Chat may be saved (ADR 0003). */
export const CHAT_DISCLOSURE_WORDING =
  'Hi, I am an AI assistant for this company. I can answer questions and set up a call with ' +
  'the team. This chat may be saved so the team can follow up.'

/** The version of {@link CHAT_DISCLOSURE_WORDING}; raised whenever its meaning changes. */
export const CHAT_DISCLOSURE_VERSION = 1

/** How long a Chat stays open after it starts. */
export const CHAT_TTL_MS = 24 * 60 * 60 * 1000

/** The most visitor messages one Chat takes; it bounds the model spend of one session. */
export const MAX_CHAT_MESSAGES = 60

/** The most new Chats one site takes a minute, all visitors together. */
export const CHAT_SESSIONS_PER_SITE_PER_MINUTE = 30

/** The most new Chats one client address may start on one site a minute. */
export const CHAT_SESSIONS_PER_IP_PER_MINUTE = 5

/** The most visitor messages one site takes a minute, all Chats together; each one is a model call. */
export const CHAT_MESSAGES_PER_SITE_PER_MINUTE = 120

/** How often a message retries for a free turn when a concurrent message took its index. */
const SEND_ATTEMPTS = 3

const CHAT_MESSAGE_ROUTE = 'chat.message'
const CHAT_CONSENT_ROUTE = 'chat.consent'

const hexOfOrganization = (organizationId: string): string => organizationId.slice('org_'.length)
const tokenHashOf = (token: string): Buffer => createHash('sha256').update(token).digest()
/** The idempotency scope of a Chat: a visitor has no user, so the Chat stands in for one. */
const scopeOf = (organizationId: string, chatId: string) => ({
  userId: formatId('usr', chatId.slice('cht_'.length)),
  organizationId: organizationIdSchema.parse(organizationId),
})
const OWNER_PREFIX = /^[0-9a-f]{32}$/

/** The Organization a session token names in its first 32 characters, or undefined for a forged one. */
function organizationOfToken(token: string): string | undefined {
  const owner = token.slice(0, 32)
  return OWNER_PREFIX.test(owner) ? `org_${owner}` : undefined
}

/** The token a start with this Idempotency-Key always gets: the Organization, then 32 keyed characters. */
function tokenFor(deps: ChatDeps, organizationId: string, idempotencyKey: string): string {
  const secret = createHmac('sha256', deps.env.PHONE_HASH_KEY)
    .update(`chat\u0000${organizationId}\u0000${idempotencyKey}`)
    .digest('base64url')
    .slice(0, 32)
  return `${hexOfOrganization(organizationId)}${secret}`
}

/**
 * Counts one request against a limit of the site and refuses it with `rate.limited` and the
 * seconds to the next minute when it is over. What is limited is hashed under the server's secret,
 * so no address is stored.
 */
async function limit(
  deps: ChatDeps,
  organizationId: string,
  what: string,
  subject: string,
  max: number
): Promise<void> {
  const keyHash = createHmac('sha256', deps.env.PHONE_HASH_KEY)
    .update(`chat-limit\u0000${what}\u0000${organizationId}\u0000${subject}`)
    .digest()
  const now = deps.clock.now()
  if (!(await deps.chatLimits.hit(organizationId, keyHash, now, max))) {
    const retryAfter = Math.max(
      1,
      Math.ceil((CHAT_RATE_WINDOW_MS - (now.getTime() % CHAT_RATE_WINDOW_MS)) / 1000)
    )
    throw new RetryAfterError(ERRORS['rate.limited'], retryAfter, { retryAfter })
  }
}

const sessionNotFound = () => domainError(CHAT_ERRORS['chat.session_not_found'])

/** Reads a page of the Chat's turns as visible messages: index 0 is the AI disclosure. */
const opening = (chat: StoredChat) => ({
  index: 0,
  role: 'agent' as const,
  text: CHAT_DISCLOSURE_WORDING,
  at: chat.startedAt,
})

/** The site of a publishable key when the call's `Origin` is one it allows. */
async function siteOfKey(deps: ChatDeps, key: string, origin: string): Promise<ChatSite> {
  const site = await deps.chatSites.ofKey(key)
  if (site === undefined) {
    throw domainError(CHAT_ERRORS['chat.key_invalid'])
  }
  assertOrigin(site, origin)
  return site
}

function assertOrigin(site: ChatSite, origin: string): void {
  if (!site.allowedOrigins.includes(origin)) {
    throw domainError(CHAT_ERRORS['chat.origin_not_allowed'])
  }
}

/** The open Chat a session token belongs to, called from an allowed origin; one error for every miss. */
async function sessionOf(
  deps: ChatDeps,
  token: string,
  origin: string
): Promise<{ organizationId: string; chat: StoredChat; site: ChatSite }> {
  const organizationId = organizationOfToken(token)
  if (organizationId === undefined) {
    throw sessionNotFound()
  }
  const [site, chat] = await Promise.all([
    deps.chatSites.ofOrganization(organizationId),
    deps.chats.byTokenHash(organizationId, tokenHashOf(token)),
  ])
  if (chat === undefined || site === undefined) {
    throw sessionNotFound()
  }
  assertOrigin(site, origin)
  if (chat.state === 'closed' || new Date(chat.expiresAt) <= deps.clock.now()) {
    throw domainError(CHAT_ERRORS['chat.session_closed'])
  }
  return { organizationId, chat, site }
}

/**
 * Starts a Chat for the site the publishable key names. The same Idempotency-Key answers the same
 * session (`replayed`). A filled honeypot is answered like a start but stores nothing, and its
 * token opens nothing.
 */
export async function start(
  deps: ChatDeps,
  input: {
    key: string
    origin: string
    idempotencyKey: string
    sourceUrl: string
    honeypot: string
    /** The caller's socket address and `X-Forwarded-For`, from which the client address is read. */
    address: { socketAddress: string | undefined; forwardedFor: string | undefined }
  }
): Promise<{ body: PublicStartChatResponse; replayed: boolean }> {
  const site = await siteOfKey(deps, input.key, input.origin)
  const client = resolveClientAddress({
    ...input.address,
    trustedProxyHops: deps.env.TRUSTED_PROXY_HOPS,
  })
  await limit(deps, site.organizationId, 'sessions', '', CHAT_SESSIONS_PER_SITE_PER_MINUTE)
  await limit(deps, site.organizationId, 'sessions-ip', client, CHAT_SESSIONS_PER_IP_PER_MINUTE)
  const now = deps.clock.now()
  const expiresAt = new Date(now.getTime() + CHAT_TTL_MS)
  const message = (at: string) => [
    { index: 0, role: 'agent' as const, text: CHAT_DISCLOSURE_WORDING, at },
  ]
  if (input.honeypot !== '') {
    const token = `${hexOfOrganization(site.organizationId)}${randomBytes(24).toString('base64url')}`
    return {
      body: {
        sessionToken: token,
        expiresAt: expiresAt.toISOString(),
        messages: message(now.toISOString()),
      },
      replayed: false,
    }
  }
  const token = tokenFor(deps, site.organizationId, input.idempotencyKey)
  const { chat, created } = await deps.chats.start(site.organizationId, {
    id: formatId('cht', crypto.randomUUID()),
    tokenHash: tokenHashOf(token),
    sourceUrl: input.sourceUrl,
    startedAt: now,
    expiresAt,
  })
  if (!created && chat.sourceUrl !== input.sourceUrl) {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  return {
    body: { sessionToken: token, expiresAt: chat.expiresAt, messages: message(chat.startedAt) },
    replayed: !created,
  }
}

/**
 * The even turn index for this message: the next free one, or the index of an unanswered turn
 * with the same text (a send that failed after storing it), so a retry never stores it twice.
 */
async function nextIndex(
  deps: ChatDeps,
  organizationId: string,
  chatId: string,
  text: string
): Promise<number> {
  const [latest] = await deps.turns.recent(
    organizationId,
    { kind: 'chat', id: chatId },
    Number.MAX_SAFE_INTEGER,
    1
  )
  if (latest === undefined) {
    return 0
  }
  if (latest.role === 'prospect' && latest.text === text) {
    return latest.index
  }
  return latest.index + 1 + ((latest.index + 1) % 2)
}

/**
 * The Agent's reply to one visitor message. The Idempotency-Key makes a retry answer the first
 * reply and ask the model nothing. The visitor's text reaches the engine only as data.
 */
export async function send(
  deps: ChatDeps,
  input: { token: string; origin: string; idempotencyKey: string; text: string }
): Promise<{ body: PublicChatMessageReply; replayed: boolean }> {
  const { organizationId, chat } = await sessionOf(deps, input.token, input.origin)
  await limit(deps, organizationId, 'messages', '', CHAT_MESSAGES_PER_SITE_PER_MINUTE)
  // The model call runs outside any transaction: the key is claimed first and completed after.
  const answer = await idempotentOutside(
    deps,
    scopeOf(organizationId, chat.id),
    {
      key: input.idempotencyKey,
      route: CHAT_MESSAGE_ROUTE,
      request: { chatId: chat.id, text: input.text },
      status: 200,
      response: publicChatMessageReplySchema,
    },
    async () => {
      const conversation = { kind: 'chat' as const, id: chat.id }
      for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
        const turnIndex = await nextIndex(deps, organizationId, chat.id, input.text)
        if (turnIndex / 2 >= MAX_CHAT_MESSAGES) {
          throw domainError(CHAT_ERRORS['chat.session_closed'])
        }
        const result = await converse(deps, {
          organizationId,
          conversation,
          turnIndex,
          text: input.text,
        })
        // A concurrent message took this index first: its text was kept, so ask again further on.
        if (result.prospectTurn.text !== input.text) {
          continue
        }
        const at = result.agentTurn.createdAt
        await deps.chats.touch(organizationId, chat.id, new Date(at))
        return {
          reply: { text: result.reply, deferred: result.deferred, handoffOffered: false, at },
        }
      }
      throw domainError(ERRORS['request.idempotency_in_progress'])
    }
  )
  return { body: answer.body, replayed: answer.replayed }
}

const cursorSchema = z.strictObject({ after: z.number().int().min(0) })

/** One page of the Chat's messages, oldest first; message 0 is the AI disclosure. */
export async function listMessages(
  deps: ChatDeps,
  input: { token: string; origin: string; cursor: string | undefined; limit: number }
): Promise<PublicChatMessagePage> {
  const { organizationId, chat } = await sessionOf(deps, input.token, input.origin)
  let after = -1
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, cursorSchema)
    if (decoded === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    after = decoded.after
  }
  const items: PublicChatMessagePage['items'] = []
  if (after < 0) {
    items.push(opening(chat))
  }
  // Message i (i >= 1) is stored turn i - 1; fetch the stored range that fills the page, plus one.
  const from = Math.max(after, 0)
  const stored = await deps.turns.range(
    organizationId,
    { kind: 'chat', id: chat.id },
    from,
    from + input.limit
  )
  for (const turn of stored) {
    items.push({ index: turn.index + 1, role: turn.role, text: turn.text, at: turn.createdAt })
  }
  const page = items.slice(0, input.limit)
  const last = page[page.length - 1]
  return {
    items: page,
    nextCursor:
      items.length > input.limit && last !== undefined ? encodeCursor({ after: last.index }) : null,
  }
}

/**
 * Records the visitor's name, phone and callback choice. The wording they saw must be the current
 * one, or nothing is recorded. Core keeps the Prospect and the Contact Consent; the Chat becomes
 * an Inquiry carrying the wording id and version.
 */
export async function recordConsent(
  deps: ChatDeps,
  input: {
    token: string
    origin: string
    idempotencyKey: string
    request: PublicChatConsentRequest
  }
): Promise<{ body: PublicChatConsentReceipt; replayed: boolean }> {
  const { organizationId, chat, site } = await sessionOf(deps, input.token, input.origin)
  const { request } = input
  if (
    site.wording.id !== request.consentWordingId ||
    site.wording.version !== request.consentWordingVersion
  ) {
    throw domainError(CHAT_ERRORS['chat.consent_wording_missing'])
  }
  const answer = await deps.idempotency.withOrganization(organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      scopeOf(organizationId, chat.id),
      {
        key: input.idempotencyKey,
        route: CHAT_CONSENT_ROUTE,
        request: { chatId: chat.id, ...request },
        status: 201,
        response: publicChatConsentReceiptSchema,
      },
      async () => {
        const at = deps.clock.now()
        const { prospectId } = await deps.consents.record({
          organizationId,
          idempotencyKey: `chat:${chat.id}`,
          name: request.name,
          phone: request.phone,
          wordingId: request.consentWordingId,
          wordingVersion: request.consentWordingVersion,
          agreed: request.callbackConsent,
          sourceUrl: request.sourceUrl,
          at,
        })
        await deps.chats.becomeInquiry(organizationId, chat.id, {
          prospectId,
          wordingId: request.consentWordingId,
          wordingVersion: request.consentWordingVersion,
          sourceUrl: request.sourceUrl,
          agreed: request.callbackConsent,
          at,
        })
        return { received: true as const, receivedAt: at.toISOString() }
      }
    )
  )
  return { body: answer.body, replayed: answer.replayed }
}
