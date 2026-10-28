import type { CopilotSettings } from 'tula-closeline-contract'

/** Where an Organization's Copilot settings are kept: one row per Organization, written whole. */
export type CopilotSettingsStore = {
  /** The Organization's settings, or `undefined` when none were ever saved. */
  get: (organizationId: string) => Promise<CopilotSettings | undefined>
  /** Replaces the settings, creating the row on the first write. */
  put: (organizationId: string, settings: CopilotSettings) => Promise<CopilotSettings>
}
