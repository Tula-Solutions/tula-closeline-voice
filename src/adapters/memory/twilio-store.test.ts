import { createMemoryTwilioStore } from 'tula-closeline-kit'
import { twilioStoreBehaviour } from '../postgres/twilio-store.behaviour'

twilioStoreBehaviour('memory', createMemoryTwilioStore)
