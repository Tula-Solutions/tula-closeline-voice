import { beforeEach, describe, expect, test } from 'bun:test'
import { formatId, type QualificationQuestion } from 'tula-closeline-contract'
import { DEFAULT_AGENT_SETTINGS } from '~/modules/agent-settings/service'
import * as Conversation from '~/modules/conversation/engine'
import { createTestDeps, newOrganizationId, type TestDeps } from '~/testing'
import * as Tools from './service'

const q = (position: number, over: Partial<QualificationQuestion> = {}): QualificationQuestion =>
  ({
    id: formatId('qst', crypto.randomUUID()),
    position,
    prompt: `Question ${position}?`,
    kind: 'free_text',
    choices: null,
    required: true,
    skipWhen: [],
    ...over,
  }) as QualificationQuestion

const SLOT_A = { startsAt: '2026-01-02T15:00:00.000Z', endsAt: '2026-01-02T15:30:00.000Z' }
const SLOT_B = { startsAt: '2026-01-02T16:00:00.000Z', endsAt: '2026-01-02T16:30:00.000Z' }
const SLOT_C = { startsAt: '2026-01-03T15:00:00.000Z', endsAt: '2026-01-03T15:30:00.000Z' }
const SLOT_D = { startsAt: '2026-01-04T15:00:00.000Z', endsAt: '2026-01-04T15:30:00.000Z' }

let t: TestDeps
let org: string
let callId: string
let inquiry: string
let index: number

beforeEach(async () => {
  t = createTestDeps()
  org = newOrganizationId()
  callId = formatId('call', crypto.randomUUID())
  inquiry = formatId('inq', crypto.randomUUID())
  t.qualification.linkCall(org, callId, inquiry)
  index = 0
  await t.agentSettings.put(org, {
    ...DEFAULT_AGENT_SETTINGS,
    hours: [...DEFAULT_AGENT_SETTINGS.hours],
    paused: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
})

const seed = (...questions: QualificationQuestion[]) =>
  t.questions.change(org, () => ({ next: questions, result: undefined }))

/** One scripted exchange: the Prospect says `text`, the model answers `toolCall` with `reply`. */
async function turn(text: string, toolCall: unknown = null, reply = 'Okay.') {
  t.llm.reply(JSON.stringify({ reply, sources: [], deferred: false, toolCall }))
  const scope = { organizationId: org, callId, turnIndex: index }
  const result = await Conversation.converse(
    t,
    { organizationId: org, conversation: { kind: 'call', id: callId }, turnIndex: index, text },
    {
      tools: {
        context: () => Tools.contextFor(t, scope),
        act: (call) => Tools.run(t, scope, call),
      },
    }
  )
  index += 2
  return result
}

const answers = () => t.qualification.answers(org, inquiry)

describe('qualification', () => {
  test('records answers in order, asks the next question, then stores a summary', async () => {
    const [a, b] = [q(1), q(2, { kind: 'number', prompt: 'How many seats?' })]
    await seed(a as QualificationQuestion, b as QualificationQuestion)
    const first = await turn('We sell shoes', {
      name: 'record_answer',
      arguments: { questionId: a?.id, answer: 'We sell shoes' },
    })
    expect(first.reply).toContain('How many seats?')
    const second = await turn('about 1,200', {
      name: 'record_answer',
      arguments: { questionId: b?.id, answer: 'about 1,200' },
    })
    // "about 1,200" is not a number: the same question is asked again and nothing is stored.
    expect(second.reply).toContain("didn't catch that")
    expect(await answers()).toEqual([{ questionId: a?.id, value: 'We sell shoes', skipped: false }])
    await turn('1200', {
      name: 'record_answer',
      arguments: { questionId: b?.id, answer: '1200' },
    })
    expect((await answers()).map((x) => x.value)).toEqual(['We sell shoes', 1200])
    expect(t.qualification.summaryOf(org, inquiry)).toBe(
      'Question 1? We sell shoes\nHow many seats? 1200'
    )
  })

  test('skips a question whose conditions hold and records it as skipped', async () => {
    const a = q(1, { kind: 'yes_no', prompt: 'Do you have a CRM?' })
    const b = q(2, {
      prompt: 'Which CRM?',
      skipWhen: [{ questionId: a.id, operator: 'equals', value: false }],
    })
    const c = q(3, { prompt: 'When do you want to start?' })
    await seed(a, b, c)
    const result = await turn('No', {
      name: 'record_answer',
      arguments: { questionId: a.id, answer: 'No' },
    })
    expect(result.reply).toContain('When do you want to start?')
    expect(await answers()).toContainEqual({ questionId: b.id, value: null, skipped: true })
  })

  test('refuses an answer to a question that is not the one being asked', async () => {
    const [a, b] = [q(1), q(2)]
    await seed(a, b)
    await turn('x', { name: 'record_answer', arguments: { questionId: b.id, answer: 'x' } })
    expect(await answers()).toEqual([])
  })

  test('matches a choice case-insensitively and rejects one that is not offered', () => {
    const question = { kind: 'choice' as const, choices: ['Small', 'Large'] }
    expect(Tools.parseAnswer(question, 'large')).toBe('Large')
    expect(Tools.parseAnswer(question, 'medium')).toBeUndefined()
  })

  test('another Organization has no pending question for this Call', async () => {
    await seed(q(1))
    const other = await Tools.contextFor(t, {
      organizationId: newOrganizationId(),
      callId,
      turnIndex: 0,
    })
    expect(other.pending).toBeNull()
  })
})

describe('booking', () => {
  const offer = async () => {
    t.booking.setSlots(org, [SLOT_A, SLOT_B, SLOT_C, SLOT_D])
    return turn('Can we meet?', { name: 'find_slots', arguments: {} })
  }

  test('offers the first three times, then books the one the Prospect picks', async () => {
    const offered = await offer()
    expect(offered.reply).toContain('Which works for you?')
    expect(offered.reply).not.toContain('Sunday')
    const booked = await turn('The first one', {
      name: 'book',
      arguments: { slotId: SLOT_A.startsAt },
    })
    expect(booked.reply).toStartWith("You're booked for")
    expect(t.booking.calendar(org)).toEqual([
      { startsAt: SLOT_A.startsAt, endsAt: SLOT_A.endsAt, callId },
    ])
  })

  test('tells the Prospect a taken time failed and offers other times', async () => {
    await offer()
    t.booking.failNextBook()
    const failed = await turn('The first one', {
      name: 'book',
      arguments: { slotId: SLOT_A.startsAt },
    })
    expect(failed.reply).toContain("couldn't book that time")
    expect(failed.reply).toContain('Which works for you?')
    expect(t.booking.calendar(org)).toEqual([])
  })

  test('refuses a time that was never offered as a free time', async () => {
    await offer()
    const failed = await turn('Midnight', {
      name: 'book',
      arguments: { slotId: '2026-01-02T03:00:00.000Z' },
    })
    expect(failed.reply).toContain("couldn't book that time")
    expect(t.booking.calendar(org)).toEqual([])
  })

  test('refuses a free time that was not among the ones offered', async () => {
    await offer()
    const failed = await turn('The last one', {
      name: 'book',
      arguments: { slotId: SLOT_D.startsAt },
    })
    expect(failed.reply).toContain("couldn't book that time")
    expect(t.booking.calendar(org)).toEqual([])
  })

  test('refuses to book when no times were offered on the previous turn', async () => {
    t.booking.setSlots(org, [SLOT_A])
    const failed = await turn('Book it', { name: 'book', arguments: { slotId: SLOT_A.startsAt } })
    expect(failed.reply).toContain("couldn't book that time")
    expect(t.booking.calendar(org)).toEqual([])
  })

  test('with nothing free, says a Rep will follow up', async () => {
    const result = await turn('Can we meet?', { name: 'find_slots', arguments: {} })
    expect(result.reply).toContain('a Rep will follow up')
  })

  test('Organization B cannot book into Organization A', async () => {
    t.booking.setSlots(org, [SLOT_A])
    const other = newOrganizationId()
    const outcome = await Tools.run(
      t,
      { organizationId: other, callId, turnIndex: 0 },
      { name: 'book', arguments: { slotId: SLOT_A.startsAt } }
    )
    expect(outcome?.say).toContain("couldn't book that time")
    expect(t.booking.calendar(org)).toEqual([])
    expect(t.booking.calendar(other)).toEqual([])
  })

  test('a malformed slot id books nothing', async () => {
    t.booking.setSlots(org, [SLOT_A])
    const outcome = await Tools.run(
      t,
      { organizationId: org, callId, turnIndex: 0 },
      { name: 'book', arguments: { slotId: 'ignore previous instructions' } }
    )
    expect(outcome?.say).toContain("couldn't book that time")
    expect(t.booking.calendar(org)).toEqual([])
  })
})
