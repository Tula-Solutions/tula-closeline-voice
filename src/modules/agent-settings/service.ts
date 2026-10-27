import {
  AGENT_ADMIN_ROLES,
  AGENT_ERRORS,
  AGENT_READ_ROLES,
  type AgentSettings,
  agentSettingsSchema,
  type CreateQualificationQuestionRequest,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  MAX_QUALIFICATION_QUESTIONS,
  membershipIdSchema,
  type QualificationQuestion,
  qualificationQuestionIdSchema,
  type qualificationQuestionPageSchema,
  qualificationQuestionSchema,
  type Role,
  type SetAgentSettingsRequest,
  setAgentSettingsRequestSchema,
  type UpdateQualificationQuestionRequest,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import type { IdempotencyScope } from '~/ports/idempotency-store'
import { firstBadCondition, renumber } from './skip-logic'

/** One page of Qualification questions. */
type QuestionPage = z.infer<typeof qualificationQuestionPageSchema>

/** What the Agent settings service needs from the container. */
export type AgentSettingsDeps = Pick<
  Container,
  'agentSettings' | 'questions' | 'directory' | 'clock' | 'logger' | 'idempotency'
>

/** The most questions one page returns, which is more than an Organization may keep. */
const QUESTION_PAGE_MAX = 100

const pageOfAll: z.ZodType<QuestionPage> = z.strictObject({
  items: z.array(qualificationQuestionSchema).max(MAX_QUALIFICATION_QUESTIONS),
  nextCursor: z.null(),
})

const questionCursorSchema = z.strictObject({
  position: z.number().int().min(1),
  id: qualificationQuestionIdSchema,
})

/**
 * The settings an Organization has until an Admin saves its own. The Agent starts paused, so a
 * new Organization answers and calls nothing until someone turns it on. The contract defines no
 * defaults, so these are the service's.
 */
export const DEFAULT_AGENT_SETTINGS: Readonly<AgentSettings> = Object.freeze({
  paused: true,
  greeting: 'Hi, thanks for getting in touch. How can I help?',
  voiceStyle: 'warm',
  timeZone: 'UTC',
  hours: (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((day) => ({
    day,
    windows: [{ start: '09:00', end: '17:00' }],
  })),
  maxCallSeconds: 600,
  maxCostUsdCents: 200,
  concurrencyCap: 5,
  languages: ['en' as const],
  updatedAt: new Date(0).toISOString(),
  updatedByMembershipId: null,
})

const hasRole = (roles: readonly Role[], caller: Caller): boolean => roles.includes(caller.role)

/** Owner, Admin and Manager; the role comes from the verified token. */
function requireReader(caller: Caller): void {
  if (!hasRole(AGENT_READ_ROLES, caller)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
}

/** Owner and Admin only; the role comes from the verified token. */
function requireAdmin(caller: Caller): void {
  if (!hasRole(AGENT_ADMIN_ROLES, caller)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
}

/** Whether the runtime knows `timeZone` as an IANA zone. */
function knownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** Reads the settings of the caller's Organization; the defaults (paused) when none were saved. */
export async function getSettings(deps: AgentSettingsDeps, caller: Caller): Promise<AgentSettings> {
  requireReader(caller)
  return (await deps.agentSettings.get(caller.organizationId)) ?? { ...DEFAULT_AGENT_SETTINGS }
}

/** The route name a settings `Idempotency-Key` is stored under. */
export const SET_SETTINGS_ROUTE = 'agent.settings.set'

/** Replaces the settings, checking the hours and the zone; a repeat of the same body changes nothing. */
export async function setSettings(
  deps: AgentSettingsDeps,
  caller: Caller,
  request: SetAgentSettingsRequest,
  idempotencyKey?: string
): Promise<IdempotentAnswer<200, AgentSettings>> {
  requireAdmin(caller)
  // The service checks again what the route's schema checks, so a caller that skips the route is
  // held to the same rules, and the zone must be one the runtime knows.
  if (
    !setAgentSettingsRequestSchema.safeParse(request).success ||
    !knownTimeZone(request.timeZone)
  ) {
    throw domainError(AGENT_ERRORS['agent.settings_invalid'])
  }
  const membership = await deps.directory.membershipOf(caller.organizationId, caller.userId)
  const updatedByMembershipId = membershipIdSchema.safeParse(membership).data ?? null
  const write = (within?: IdempotencyScope): Promise<AgentSettings> =>
    deps.agentSettings.put(
      caller.organizationId,
      {
        ...request,
        languages: ['en' as const],
        updatedAt: deps.clock.now().toISOString(),
        updatedByMembershipId,
      },
      within
    )
  return keyed(
    deps,
    caller,
    idempotencyKey,
    SET_SETTINGS_ROUTE,
    request,
    200,
    agentSettingsSchema,
    write
  )
}

/** Whether the Agent is paused for the Organization: switched off, or never set up. */
export async function isPaused(
  deps: Pick<AgentSettingsDeps, 'agentSettings'>,
  organizationId: string
): Promise<boolean> {
  const settings = await deps.agentSettings.get(organizationId)
  return settings === undefined || settings.paused
}

/** Refuses with `agent.paused` while the Agent is paused; the check every callback and answer makes first. */
export async function assertNotPaused(
  deps: Pick<AgentSettingsDeps, 'agentSettings'>,
  organizationId: string
): Promise<void> {
  if (await isPaused(deps, organizationId)) {
    throw domainError(AGENT_ERRORS['agent.paused'])
  }
}

/**
 * Runs `write` once per `Idempotency-Key`: with a key the write and the key commit together and a
 * repeat answers with the stored answer (`replayed`); without one the write simply runs.
 */
async function keyed<S extends number, T>(
  deps: AgentSettingsDeps,
  caller: Caller,
  key: string | undefined,
  route: string,
  request: unknown,
  status: S,
  response: z.ZodType<T>,
  write: (within?: IdempotencyScope) => Promise<T>
): Promise<IdempotentAnswer<S, T>> {
  if (key === undefined) {
    return { status, body: await write(), replayed: false }
  }
  return deps.idempotency.withOrganization(caller.organizationId, (scope) =>
    idempotent(deps, scope, caller, { key, route, request, status, response }, () => write(scope))
  )
}

const invalidQuestion = () => domainError(AGENT_ERRORS['agent.question_invalid'])
const questionNotFound = () => domainError(AGENT_ERRORS['agent.question_not_found'])

/** Keeps a list only when every skip condition looks at an earlier question; otherwise refuses. */
function validated(questions: QualificationQuestion[]): QualificationQuestion[] {
  if (firstBadCondition(questions) !== undefined) {
    throw invalidQuestion()
  }
  return questions
}

/** Lists the Organization's questions in the order the Agent asks them, one cursor page at a time. */
export async function listQuestions(
  deps: AgentSettingsDeps,
  caller: Caller,
  query: { cursor?: string | undefined; limit: number }
): Promise<QuestionPage> {
  requireReader(caller)
  const cursor =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, questionCursorSchema)
  if (query.cursor !== undefined && cursor === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const limit = Math.min(query.limit, QUESTION_PAGE_MAX)
  // One row more than asked tells whether another page follows without a count.
  const rows = await deps.questions.list(caller.organizationId, {
    limit: limit + 1,
    ...(cursor === undefined ? {} : { cursor }),
  })
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ position: last.position, id: last.id }) : null,
  }
}

/** Reads one question of the caller's Organization. */
export async function getQuestion(
  deps: AgentSettingsDeps,
  caller: Caller,
  id: QualificationQuestion['id']
): Promise<QualificationQuestion> {
  requireReader(caller)
  const question = await deps.questions.get(caller.organizationId, id)
  if (question === undefined) {
    throw questionNotFound()
  }
  return question
}

/** The route name a create-question `Idempotency-Key` is stored under. */
export const CREATE_QUESTION_ROUTE = 'agent.questions.create'

/** Adds a question, last unless `position` says otherwise; skip logic may only look at earlier ones. */
export async function createQuestion(
  deps: AgentSettingsDeps,
  caller: Caller,
  request: CreateQualificationQuestionRequest,
  idempotencyKey?: string
): Promise<IdempotentAnswer<201, QualificationQuestion>> {
  requireAdmin(caller)
  const { position, ...content } = request
  const id = formatId('qst', crypto.randomUUID())
  const write = (within?: IdempotencyScope): Promise<QualificationQuestion> =>
    deps.questions.change(
      caller.organizationId,
      (current) => {
        if (current.length >= MAX_QUALIFICATION_QUESTIONS) {
          throw invalidQuestion()
        }
        const at = position === undefined ? current.length + 1 : position
        if (at > current.length + 1) {
          throw invalidQuestion()
        }
        const created = qualificationQuestionSchema.parse({ id, position: at, ...content })
        const next = renumber([...current.slice(0, at - 1), created, ...current.slice(at - 1)])
        validated(next)
        return { next, result: next[at - 1] ?? created }
      },
      within
    )
  return keyed(
    deps,
    caller,
    idempotencyKey,
    CREATE_QUESTION_ROUTE,
    request,
    201,
    qualificationQuestionSchema,
    write
  )
}

/** Replaces a question's prompt, kind, choices, required flag and skip logic; its position stays. */
export async function updateQuestion(
  deps: AgentSettingsDeps,
  caller: Caller,
  id: QualificationQuestion['id'],
  request: UpdateQualificationQuestionRequest
): Promise<QualificationQuestion> {
  requireAdmin(caller)
  return deps.questions.change(caller.organizationId, (current) => {
    const existing = current.find((q) => q.id === id)
    if (existing === undefined) {
      throw questionNotFound()
    }
    const updated = qualificationQuestionSchema.parse({
      id,
      position: existing.position,
      ...request,
    })
    const next = validated(current.map((q) => (q.id === id ? updated : q)))
    return { next, result: updated }
  })
}

/** Removes a question, unless a later question's skip logic looks at it. */
export async function deleteQuestion(
  deps: AgentSettingsDeps,
  caller: Caller,
  id: QualificationQuestion['id']
): Promise<void> {
  requireAdmin(caller)
  await deps.questions.change(caller.organizationId, (current) => {
    if (!current.some((q) => q.id === id)) {
      throw questionNotFound()
    }
    return { next: validated(renumber(current.filter((q) => q.id !== id))), result: undefined }
  })
}

/** The route name a reorder `Idempotency-Key` is stored under. */
export const REORDER_QUESTIONS_ROUTE = 'agent.questions.reorder'

/** Sets the order of all questions from a list of every id once; returns the questions in that order. */
export async function reorderQuestions(
  deps: AgentSettingsDeps,
  caller: Caller,
  request: { questionIds: QualificationQuestion['id'][] },
  idempotencyKey?: string
): Promise<IdempotentAnswer<200, QuestionPage>> {
  requireAdmin(caller)
  const write = async (within?: IdempotencyScope): Promise<QuestionPage> => {
    const items = await deps.questions.change(
      caller.organizationId,
      (current) => {
        const byId = new Map(current.map((q) => [q.id, q]))
        if (request.questionIds.some((id) => !byId.has(id))) {
          throw questionNotFound()
        }
        if (request.questionIds.length !== current.length) {
          throw invalidQuestion()
        }
        const next = validated(renumber(request.questionIds.flatMap((id) => byId.get(id) ?? [])))
        return { next, result: next }
      },
      within
    )
    return { items, nextCursor: null }
  }
  return keyed(
    deps,
    caller,
    idempotencyKey,
    REORDER_QUESTIONS_ROUTE,
    request,
    200,
    pageOfAll,
    write
  )
}
