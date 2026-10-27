import type { AgentSettings } from 'tula-closeline-contract'
import type { IdempotencyScope } from '~/ports/idempotency-store'

/**
 * Where an Organization's Inbound Agent settings are kept: one row per Organization, written whole.
 * Every method takes the Organization first and reaches that Organization's row only.
 */
export type AgentSettingsStore = {
  /** The Organization's settings, or `undefined` when none were ever set (the Agent is not set up). */
  get: (organizationId: string) => Promise<AgentSettings | undefined>
  /**
   * Replaces the settings (creating the row on the first write). With `within`, the write joins that
   * idempotency transaction, so the settings and their key commit or roll back together.
   */
  put: (
    organizationId: string,
    settings: AgentSettings,
    within?: IdempotencyScope
  ) => Promise<AgentSettings>
}
