import {
  COPILOT_ERRORS,
  type CopilotSettings,
  DEFAULT_COPILOT_MIN_DEALS,
  DEFAULT_COPILOT_MIN_MOMENTS,
  ERRORS,
  membershipIdSchema,
  type Role,
  type SetCopilotSettingsRequest,
  setCopilotSettingsRequestSchema,
  VOICE_ADMIN_ROLES,
  VOICE_ALL_ROLES,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'

/** What the Copilot settings need from the container. */
export type CopilotSettingsDeps = Pick<
  Container,
  'copilotSettings' | 'directory' | 'clock' | 'logger'
>

/** What an Organization has until an Admin saves its own: the Copilot off, the default minimums. */
export const DEFAULT_COPILOT_SETTINGS: Readonly<CopilotSettings> = Object.freeze({
  enabled: false,
  minMoments: DEFAULT_COPILOT_MIN_MOMENTS,
  minDeals: DEFAULT_COPILOT_MIN_DEALS,
  updatedAt: null,
  updatedBy: null,
})

/** The settings in force for an Organization (the one function the cards and the dial read through). */
export async function forOrganization(
  deps: Pick<CopilotSettingsDeps, 'copilotSettings'>,
  organizationId: string
): Promise<CopilotSettings> {
  return (await deps.copilotSettings.get(organizationId)) ?? { ...DEFAULT_COPILOT_SETTINGS }
}

/** Reads the caller's Organization settings; every role may, so the Softphone knows what to offer. */
export async function getSettings(
  deps: CopilotSettingsDeps,
  caller: Caller
): Promise<CopilotSettings> {
  if (!(VOICE_ALL_ROLES as readonly Role[]).includes(caller.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  return forOrganization(deps, caller.organizationId)
}

/**
 * Replaces the settings (Owner and Admin only). The write is the audit trail: the row keeps who
 * and when, and the change is logged with the values (no Prospect data is involved).
 */
export async function setSettings(
  deps: CopilotSettingsDeps,
  caller: Caller,
  request: SetCopilotSettingsRequest
): Promise<CopilotSettings> {
  if (!(VOICE_ADMIN_ROLES as readonly Role[]).includes(caller.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  // Checked here as well as at the route, so a caller that skips the route is held to the same rule.
  if (!setCopilotSettingsRequestSchema.safeParse(request).success) {
    throw domainError(COPILOT_ERRORS['copilot.min_evidence_invalid'])
  }
  const membership = await deps.directory.membershipOf(caller.organizationId, caller.userId)
  const saved = await deps.copilotSettings.put(caller.organizationId, {
    ...request,
    updatedAt: deps.clock.now().toISOString(),
    updatedBy: membershipIdSchema.safeParse(membership).data ?? null,
  })
  deps.logger.info('copilot settings changed', {
    organizationId: caller.organizationId,
    updatedBy: saved.updatedBy,
    enabled: saved.enabled,
    minMoments: saved.minMoments,
    minDeals: saved.minDeals,
  })
  return saved
}
