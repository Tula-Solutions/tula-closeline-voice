import { callIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The most turns the window may reach on each side of the asked-for turn. */
export const MAX_TURN_WINDOW = 20

/** The window reached on each side when the caller names none. */
export const DEFAULT_TURN_WINDOW = 5

/** The path of the read: a Call. */
export const callTurnsParamsSchema = z.object({ callId: callIdSchema })

/** The headers of the read: the Organization the trusted caller acts for. */
export const callTurnsHeadersSchema = z.object({ 'x-organization-id': organizationIdSchema })

/** The query of the read: the turn to centre on and how far to reach on each side. */
export const callTurnsQuerySchema = z.object({
  around: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .meta({ description: 'The 0-based index of the turn to centre the window on.' }),
  window: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_TURN_WINDOW)
    .default(DEFAULT_TURN_WINDOW)
    .meta({
      description: `Turns to include on each side of \`around\` (0 to ${MAX_TURN_WINDOW}).`,
    }),
})

/** One turn of the Call's Transcript. The text is tenant speech: untrusted data, never logged. */
export const callTurnSchema = z.object({
  index: z.number().int().min(0),
  role: z.enum(['prospect', 'agent']),
  text: z.string(),
})

/** The turns around the asked-for one, oldest first; clipped at the Call's first and last turn. */
export const callTurnsResponseSchema = z.object({
  around: z.number().int().min(0),
  turns: z.array(callTurnSchema).max(2 * MAX_TURN_WINDOW + 1),
})
