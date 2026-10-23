import { ERRORS } from 'tula-closeline-contract'
import type { TelephonyPort } from 'tula-closeline-kit'
import { AppError } from 'tula-closeline-kit'
import type { NumberProvisioner } from '~/ports/number-provisioner'
import type { OrganizationDirectory } from '~/ports/organization-directory'

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
