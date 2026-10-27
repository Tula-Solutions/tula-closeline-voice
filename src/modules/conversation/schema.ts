import {
  HANDOFF_REASONS,
  MAX_ANSWER_LENGTH,
  MAX_TURN_SOURCES,
  MAX_TURN_TEXT_LENGTH,
  qualificationQuestionIdSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

/** One tool call the Agent may make, checked argument by argument; the names are `AGENT_TOOLS`. */
export const toolCallSchema = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.literal('record_answer'),
    arguments: z.strictObject({
      questionId: qualificationQuestionIdSchema,
      answer: z.string().trim().min(1).max(MAX_ANSWER_LENGTH),
    }),
  }),
  z.strictObject({ name: z.literal('find_slots'), arguments: z.strictObject({}) }),
  z.strictObject({
    name: z.literal('book'),
    arguments: z.strictObject({ slotId: z.string().min(1).max(128) }),
  }),
  z.strictObject({
    name: z.literal('hand_off'),
    arguments: z.strictObject({ reason: z.enum(HANDOFF_REASONS) }),
  }),
  z.strictObject({ name: z.literal('end_call'), arguments: z.strictObject({}) }),
  z.strictObject({ name: z.literal('revoke_consent'), arguments: z.strictObject({}) }),
])

/** A validated tool call: a name from the closed set and its checked arguments. */
export type ToolCall = z.infer<typeof toolCallSchema>

/** What the model must answer: the reply, the passages it relied on, and at most one tool call. */
export const modelReplySchema = z.strictObject({
  reply: z.string().trim().min(1).max(MAX_TURN_TEXT_LENGTH),
  sources: z.array(z.string().regex(/^P[1-9][0-9]?$/)).max(MAX_TURN_SOURCES),
  deferred: z.boolean(),
  toolCall: toolCallSchema.nullable(),
})

/** The model's reply as validated. */
export type ModelReply = z.infer<typeof modelReplySchema>

/** What a caller gives the engine for one Prospect message. */
export const converseInputSchema = z.strictObject({
  organizationId: z.string().min(1),
  conversation: z.strictObject({ kind: z.enum(['call', 'chat', 'try']), id: z.string().min(1) }),
  /** The 0-based index of the Prospect turn: even, and the idempotency key of the exchange. */
  turnIndex: z
    .number()
    .int()
    .min(0)
    .refine((index) => index % 2 === 0, 'A Prospect turn has an even index'),
  text: z.string().trim().min(1).max(MAX_TURN_TEXT_LENGTH),
})

/** The input of {@link converse}. */
export type ConverseInput = z.input<typeof converseInputSchema>
