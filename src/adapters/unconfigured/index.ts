import { ERRORS } from 'tula-closeline-contract'
import type { StreamingTranscribePort, TelephonyPort } from 'tula-closeline-kit'
import { AppError, CONTACT_UNAVAILABLE, type ContactGuard } from 'tula-closeline-kit'
import { BookingFailedError, type BookingGateway } from '~/ports/booking-gateway'
import type { EvidenceSearch } from '~/ports/evidence-search'
import type { NumberProvisioner } from '~/ports/number-provisioner'
import type { OrganizationDirectory } from '~/ports/organization-directory'
import type { ProspectDirectory } from '~/ports/prospect-directory'

const unavailable = (): AppError =>
  new AppError({
    code: ERRORS['server.unavailable'].code,
    status: ERRORS['server.unavailable'].status,
    message: ERRORS['server.unavailable'].message,
  })

/** A provisioner for a deployment with no telephony provider wired: every call fails closed. */
export function createUnconfiguredNumberProvisioner(): NumberProvisioner {
  return {
    buy: async () => Promise.reject(unavailable()),
    port: async () => Promise.reject(unavailable()),
    release: async () => Promise.reject(unavailable()),
  }
}

/** A directory for a deployment with no link to the core service: every call fails closed. */
export function createUnconfiguredOrganizationDirectory(): OrganizationDirectory {
  return {
    teamExists: async () => Promise.reject(unavailable()),
    isRep: async () => Promise.reject(unavailable()),
    membershipOf: async () => Promise.reject(unavailable()),
    teamRepsOf: async () => Promise.reject(unavailable()),
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
  return { search: async () => Promise.reject(unavailable()) }
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

/** A Prospect directory for a deployment with no link to core: every lookup fails closed. */
export function createUnconfiguredProspectDirectory(): ProspectDirectory {
  return { lookup: async () => Promise.reject(unavailable()) }
}

/** A Contact Check for a deployment with no link to core: every check is denied, never skipped. */
export function createUnconfiguredContactGuard(): ContactGuard {
  return { check: async () => CONTACT_UNAVAILABLE }
}
