import {
  MAX_QUALIFICATION_SUMMARY_LENGTH,
  type QualificationQuestion,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import type { ToolCall } from '~/modules/conversation/schema'
import { BookingFailedError, type BookingSlot } from '~/ports/booking-gateway'
import type { AnswerValue, StoredAnswer } from '~/ports/qualification-store'

/** What the Inbound Agent's qualification and booking tools need from the container. */
export type AgentToolsDeps = Pick<
  Container,
  'qualification' | 'booking' | 'questions' | 'agentSettings' | 'turns' | 'clock' | 'logger'
>

/** Which exchange of which Call a tool belongs to; `turnIndex` is the Prospect turn's index. */
export type ToolScope = { organizationId: string; callId: string; turnIndex: number }

/** The question the Agent asks next. */
export type PendingQuestion = Pick<QualificationQuestion, 'id' | 'prompt' | 'kind' | 'choices'>

/** A free time the Agent offered, with the id the model books it by (its ISO start). */
export type OfferedSlot = { id: string; label: string }

/** What the model is told about the Call's state. */
export type ToolContext = { pending: PendingQuestion | null; slots: OfferedSlot[] }

/** What a tool says to the Prospect: appended to the reply, or in its place. */
export type ToolOutcome = { say: string; replace: boolean }

/** The most free times offered at once. */
export const OFFERED_SLOTS = 3

/** How far ahead free times are looked for, in days. */
export const SLOT_HORIZON_DAYS = 14

/** The most questions an Organization has. */
const MAX_QUESTIONS = 50

const DAY_MS = 86_400_000

type Walk = { pending: QualificationQuestion | null; skipped: string[] }

/** Whether one skip condition holds, given the answers so far (`undefined`: not answered). */
function holds(
  condition: QualificationQuestion['skipWhen'][number],
  known: ReadonlyMap<string, AnswerValue | undefined>
): boolean {
  const value = known.get(condition.questionId) ?? undefined
  const expected = condition.value
  switch (condition.operator) {
    case 'answered':
      return value !== undefined
    case 'not_answered':
      return value === undefined
    case 'equals':
      return value !== undefined && String(value).toLowerCase() === String(expected).toLowerCase()
    case 'not_equals':
      return value !== undefined && String(value).toLowerCase() !== String(expected).toLowerCase()
    case 'greater_than':
      return typeof value === 'number' && typeof expected === 'number' && value > expected
    case 'less_than':
      return typeof value === 'number' && typeof expected === 'number' && value < expected
  }
}

/**
 * Walks the questions in order: an answered one is done, one whose skip conditions all hold is
 * skipped, the first other one is pending. Conditions name earlier questions only, so stopping at
 * the first pending question is complete.
 */
export function walk(
  questions: readonly QualificationQuestion[],
  answers: readonly StoredAnswer[]
): Walk {
  const stored = new Map(answers.map((answer) => [answer.questionId, answer]))
  const known = new Map<string, AnswerValue | undefined>()
  const skipped: string[] = []
  for (const question of questions) {
    const answer = stored.get(question.id)
    if (answer !== undefined && !answer.skipped) {
      known.set(question.id, answer.value)
      continue
    }
    const skips =
      answer?.skipped === true ||
      (question.skipWhen.length > 0 && question.skipWhen.every((c) => holds(c, known)))
    if (!skips) {
      return { pending: question, skipped }
    }
    known.set(question.id, undefined)
    skipped.push(question.id)
  }
  return { pending: null, skipped }
}

/** Turns what the Prospect said into the question's kind of value; `undefined` when it does not fit. */
export function parseAnswer(
  question: Pick<QualificationQuestion, 'kind' | 'choices'>,
  text: string
): AnswerValue | undefined {
  const said = text.trim()
  switch (question.kind) {
    case 'yes_no':
      if (/^(yes|yeah|yep|yup|y|true|sure|correct)\b/i.test(said)) {
        return true
      }
      return /^(no|nope|nah|n|false)\b/i.test(said) ? false : undefined
    case 'number': {
      const number = Number(said.replace(/[\s,$]/g, ''))
      return said !== '' && Number.isFinite(number) ? number : undefined
    }
    case 'choice':
      return question.choices?.find((choice) => choice.toLowerCase() === said.toLowerCase())
    case 'free_text':
      return said === '' ? undefined : said
  }
}

async function loadQuestions(
  deps: AgentToolsDeps,
  organizationId: string
): Promise<QualificationQuestion[]> {
  return deps.questions.list(organizationId, { limit: MAX_QUESTIONS })
}

async function formatSlots(deps: AgentToolsDeps, organizationId: string, slots: BookingSlot[]) {
  const settings = (await deps.agentSettings.get(organizationId)) ?? DEFAULT_AGENT_SETTINGS
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return slots.map((slot) => ({ id: slot.startsAt, label: format.format(new Date(slot.startsAt)) }))
}

/** Free times from now on, soonest first; `undefined` when the booking system could not answer. */
async function freeSlots(
  deps: AgentToolsDeps,
  organizationId: string,
  callId: string
): Promise<BookingSlot[] | undefined> {
  const from = deps.clock.now()
  try {
    return await deps.booking.slots(organizationId, {
      from: from.toISOString(),
      to: new Date(from.getTime() + SLOT_HORIZON_DAYS * DAY_MS).toISOString(),
    })
  } catch (error) {
    if (error instanceof BookingFailedError) {
      deps.logger.warn('agent slots unavailable', { callId })
      return undefined
    }
    throw error
  }
}

const listOf = (labels: string[]): string =>
  labels.length < 2 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`

/**
 * What the model must know before it replies: the next question to ask and, when the Agent just
 * offered times, those times. Reads only; nothing is stored.
 */
export async function contextFor(deps: AgentToolsDeps, scope: ToolScope): Promise<ToolContext> {
  const { organizationId, callId } = scope
  const inquiryId = await deps.qualification.inquiryOfCall(organizationId, callId)
  let pending: PendingQuestion | null = null
  if (inquiryId !== undefined) {
    const next = walk(
      await loadQuestions(deps, organizationId),
      await deps.qualification.answers(organizationId, inquiryId)
    ).pending
    pending = next && { id: next.id, prompt: next.prompt, kind: next.kind, choices: next.choices }
  }
  const free = await offeredSlots(deps, scope)
  return {
    pending,
    slots: free ? await formatSlots(deps, organizationId, free) : [],
  }
}

/** The times offered on the previous Agent turn (the first few free ones), if it offered any. */
async function offeredSlots(
  deps: AgentToolsDeps,
  scope: ToolScope
): Promise<BookingSlot[] | undefined> {
  const { organizationId, callId, turnIndex } = scope
  const previous =
    turnIndex > 0
      ? await deps.turns.get(organizationId, { kind: 'call', id: callId }, turnIndex - 1)
      : undefined
  if (previous?.toolName !== 'find_slots' && previous?.toolName !== 'book') {
    return undefined
  }
  return (await freeSlots(deps, organizationId, callId))?.slice(0, OFFERED_SLOTS)
}

/** Carries out a tool call. `null` when the tool is not one of these (another ticket's). */
export async function run(
  deps: AgentToolsDeps,
  scope: ToolScope,
  toolCall: ToolCall
): Promise<ToolOutcome | null> {
  switch (toolCall.name) {
    case 'record_answer':
      return recordAnswer(deps, scope, toolCall.arguments)
    case 'find_slots':
      return findSlots(deps, scope)
    case 'book':
      return book(deps, scope, toolCall.arguments.slotId)
    default:
      return null
  }
}

async function recordAnswer(
  deps: AgentToolsDeps,
  scope: ToolScope,
  args: { questionId: string; answer: string }
): Promise<ToolOutcome | null> {
  const { organizationId, callId } = scope
  const inquiryId = await deps.qualification.inquiryOfCall(organizationId, callId)
  if (inquiryId === undefined) {
    deps.logger.warn('agent answer has no inquiry', { callId })
    return null
  }
  const questions = await loadQuestions(deps, organizationId)
  const before = walk(questions, await deps.qualification.answers(organizationId, inquiryId))
  const question = before.pending
  // The model may only answer the question being asked, never skip ahead or rewrite an earlier one.
  if (question === null || question.id !== args.questionId) {
    return null
  }
  const value = parseAnswer(question, args.answer)
  if (value === undefined) {
    return { say: `Sorry, I didn't catch that. ${question.prompt}`, replace: false }
  }
  await deps.qualification.record(organizationId, inquiryId, {
    questionId: question.id,
    value,
    skipped: false,
  })
  const answers = await deps.qualification.answers(organizationId, inquiryId)
  const after = walk(questions, answers)
  for (const questionId of after.skipped) {
    await deps.qualification.record(organizationId, inquiryId, {
      questionId,
      value: null,
      skipped: true,
    })
  }
  if (after.pending !== null) {
    return { say: after.pending.prompt, replace: false }
  }
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]))
  const summary = questions
    .flatMap((q) => {
      const answer = byId.get(q.id)
      return answer && !answer.skipped ? [`${q.prompt} ${String(answer.value)}`] : []
    })
    .join('\n')
  await deps.qualification.setSummary(
    organizationId,
    inquiryId,
    [...summary].slice(0, MAX_QUALIFICATION_SUMMARY_LENGTH).join('')
  )
  return { say: 'Thank you, that is everything I needed to ask.', replace: false }
}

async function findSlots(deps: AgentToolsDeps, scope: ToolScope): Promise<ToolOutcome> {
  const free = await freeSlots(deps, scope.organizationId, scope.callId)
  const offered =
    free && (await formatSlots(deps, scope.organizationId, free.slice(0, OFFERED_SLOTS)))
  if (!offered || offered.length === 0) {
    return {
      say: 'I have no free times to offer right now, so a Rep will follow up.',
      replace: false,
    }
  }
  return {
    say: `I can offer ${listOf(offered.map((slot) => slot.label))}. Which works for you?`,
    replace: false,
  }
}

async function book(deps: AgentToolsDeps, scope: ToolScope, slotId: string): Promise<ToolOutcome> {
  const { organizationId, callId, turnIndex } = scope
  const startsAt = Date.parse(slotId)
  const slot = (await offeredSlots(deps, scope))?.find((s) => Date.parse(s.startsAt) === startsAt)
  if (slot !== undefined) {
    try {
      const booked = await deps.booking.book(organizationId, {
        callId,
        startsAt: slot.startsAt,
        idempotencyKey: `voice-book-${callId}-${turnIndex}`,
      })
      const [label] = await formatSlots(deps, organizationId, [booked])
      return { say: `You're booked for ${label?.label}.`, replace: true }
    } catch (error) {
      if (!(error instanceof BookingFailedError)) {
        throw error
      }
      deps.logger.warn('agent booking failed', { callId })
    }
  }
  const others = (await freeSlots(deps, organizationId, callId))?.filter(
    (s) => Date.parse(s.startsAt) !== startsAt
  )
  const offered =
    others && (await formatSlots(deps, organizationId, others.slice(0, OFFERED_SLOTS)))
  const alternatives =
    offered && offered.length > 0
      ? ` I can offer ${listOf(offered.map((s) => s.label))}. Which works for you?`
      : ' A Rep will follow up with you.'
  return { say: `Sorry, I couldn't book that time.${alternatives}`, replace: true }
}
