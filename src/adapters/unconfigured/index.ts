import { ERRORS } from 'tula-closeline-contract'
import type { StreamingTranscribePort, TelephonyPort } from 'tula-closeline-kit'
import { AppError, CONTACT_UNAVAILABLE, type ContactGuard } from 'tula-closeline-kit'
import { BookingFailedError, type BookingGateway } from '~/ports/booking-gateway'
import type { ChatSites, ConsentRecorder } from '~/ports/chat-sites'
import type { EvidenceSearch } from '~/ports/evidence-search'
import type { OrganizationDirectory } from '~/ports/organization-directory'
import type { ProspectDirectory } from '~/ports/prospect-directory'

const unavailable = (): AppError =>
  new AppError({
    code: ERRORS['server.unavailable'].code,
    status: ERRORS['server.unavailable'].status,
    message: ERRORS['server.unavailable'].message,
  })

/** A directory for a deployment with no link to the core service: every call fails closed. */
export function createUnconfiguredOrganizationDirectory(): OrganizationDirectory {
  return {
    teamExists: async () => Promise.reject(unavailable()),
    isRep: async () => Promise.reject(unavailable()),
    isMember: async () => Promise.reject(unavailable()),
    roleMembers: async () => Promise.reject(unavailable()),
    teamsOf: async () => Promise.reject(unavailable()),
    membershipOf: async () => Promise.reject(unavailable()),
    teamRepsOf: async () => Promise.reject(unavailable()),
    nameOf: async () => Promise.reject(unavailable()),
    onlineRepsOfTeam: async () => Promise.reject(unavailable()),
  }
}

/**
 * Telephony for a deployment whose provider cannot run yet (a durable store for its webhook and
 * call state does not exist): no token is minted and every webhook is refused.
 */
export function createUnconfiguredTelephony(): TelephonyPort {
  const refuse = async (): Promise<never> => Promise.reject(unavailable())
  return {
    placeCall: refuse,
    placeAgentCall: refuse,
    answerCall: refuse,
    playDisclosure: refuse,
    bridge: refuse,
    startRecording: refuse,
    forkTracks: refuse,
    hangUp: refuse,
    fetchRecording: refuse,
    deleteRecording: refuse,
    verifyWebhook: () => false,
    mintBrowserToken: refuse,
  }
}

/** Evidence search for a deployment with no Playbook link for the Agent: every search fails closed. */
export function createUnconfiguredEvidenceSearch(): EvidenceSearch {
  return {
    search: async () => Promise.reject(unavailable()),
    searchMoments: async () => Promise.reject(unavailable()),
    searchDocuments: async () => Promise.reject(unavailable()),
  }
}

/** Speech-to-text for a deployment with no vendor key: opening a stream fails closed. */
export function createUnconfiguredStreamingTranscribe(): StreamingTranscribePort {
  return { open: async () => Promise.reject(unavailable()) }
}

/** A booking gateway for a deployment with no booking link wired: it offers nothing and books nothing. */
export function createUnconfiguredBookingGateway(): BookingGateway {
  return {
    slots: async () => Promise.reject(new BookingFailedError('booking not configured')),
    book: async () => Promise.reject(new BookingFailedError('booking not configured')),
  }
}

/** Chat sites for a deployment with no publishable-key resolution yet: every key is unavailable. */
export function createUnconfiguredChatSites(): ChatSites {
  return {
    ofKey: async () => Promise.reject(unavailable()),
    ofOrganization: async () => Promise.reject(unavailable()),
  }
}

/** A consent recorder for a deployment with no core consent route yet: it fails closed. */
export function createUnconfiguredConsentRecorder(): ConsentRecorder {
  return { record: async () => Promise.reject(unavailable()) }
}

/** A Prospect directory for a deployment with no link to core: every lookup fails closed. */
export function createUnconfiguredProspectDirectory(): ProspectDirectory {
  return { lookup: async () => Promise.reject(unavailable()) }
}

/** A Contact Check for a deployment with no link to core: every check is denied, never skipped. */
export function createUnconfiguredContactGuard(): ContactGuard {
  return { check: async () => CONTACT_UNAVAILABLE }
}
