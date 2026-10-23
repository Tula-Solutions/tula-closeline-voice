import { ERRORS } from 'tula-closeline-contract'
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
  }
}
