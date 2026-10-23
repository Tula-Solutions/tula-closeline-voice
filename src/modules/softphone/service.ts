import { ERRORS, type Role, type SoftphoneToken, VOICE_ALL_ROLES } from 'tula-closeline-contract'
import { TELEPHONY_ERROR_CODES } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'

/** What the softphone service needs from the container. */
export type SoftphoneDeps = Pick<Container, 'telephony' | 'directory' | 'logger'>

/** How long a softphone token lives. The browser asks for a new one before it runs out. */
export const SOFTPHONE_TOKEN_TTL_SECONDS = 900

/**
 * Mints a token that lets the caller's browser register as a softphone. It names the caller's
 * Membership and Organization and nothing else; the Membership is looked up from the verified
 * token's User and Organization, never taken from the request.
 */
export async function mintToken(deps: SoftphoneDeps, caller: Caller): Promise<SoftphoneToken> {
  if (!(VOICE_ALL_ROLES as readonly Role[]).includes(caller.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  const identity = await deps.directory.membershipOf(caller.organizationId, caller.userId)
  if (identity === undefined) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  try {
    return await deps.telephony.mintBrowserToken({
      organizationId: caller.organizationId,
      identity: identity as SoftphoneToken['identity'],
      ttlSeconds: SOFTPHONE_TOKEN_TTL_SECONDS,
    })
  } catch (error) {
    // The provider's message can name its own ids; the caller only learns it is unavailable.
    deps.logger.error('softphone token not minted', {
      code:
        error instanceof Error && 'code' in error
          ? String(error.code)
          : TELEPHONY_ERROR_CODES.unavailable,
    })
    throw domainError(ERRORS['server.unavailable'])
  }
}
