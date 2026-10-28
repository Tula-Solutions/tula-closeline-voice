import {
  callIdSchema,
  voiceAgentCallEndedV2Event,
  voiceCallEndedEvent,
  voiceCopilotCardRatedEvent,
} from 'tula-closeline-contract'
import {
  createMessageRegistry,
  defineMessage,
  type EnvelopeOf,
  type MessageRegistry,
} from 'tula-closeline-kit'
import { z } from 'zod'

/** The published `voice.call.ended` event, as a queue message of the contract's payload. */
export const callEndedMessage = defineMessage({
  type: 'voice.call.ended',
  version: 1,
  scope: 'organization',
  payload: voiceCallEndedEvent.schema.shape.data,
})

/** The published `voice.agent_call.ended` event (version 2), as a queue message of the contract's payload. */
export const agentCallEndedMessage = defineMessage({
  type: 'voice.agent_call.ended',
  version: 2,
  scope: 'organization',
  payload: voiceAgentCallEndedV2Event.schema.shape.data,
})

/** The published `voice.copilot.card_rated` event, as a queue message of the contract's payload. */
export const cardRatedMessage = defineMessage({
  type: 'voice.copilot.card_rated',
  version: 1,
  scope: 'organization',
  payload: voiceCopilotCardRatedEvent.schema.shape.data,
})

/** Our own job: a Call reached a final state or its Recording is ready to copy. */
export const finishRecordingMessage = defineMessage({
  type: 'voice.recording_finish',
  version: 1,
  scope: 'organization',
  payload: z.strictObject({
    callId: callIdSchema,
    /** The provider's id of the finished Recording, or null when only the Call ended. */
    recordingSid: z.string().min(1).max(64).nullable(),
  }),
})

/** The registry of the events queue (what other services consume). */
export const eventRegistry: MessageRegistry<
  typeof callEndedMessage | typeof agentCallEndedMessage | typeof cardRatedMessage
> = createMessageRegistry([callEndedMessage, agentCallEndedMessage, cardRatedMessage])

/** The registry of the jobs queue (what this service consumes). */
export const jobRegistry: MessageRegistry<typeof finishRecordingMessage> = createMessageRegistry([
  finishRecordingMessage,
])

/** An event envelope. */
export type EventEnvelope = EnvelopeOf<
  typeof callEndedMessage | typeof agentCallEndedMessage | typeof cardRatedMessage
>

/** A job envelope. */
export type JobEnvelope = EnvelopeOf<typeof finishRecordingMessage>
