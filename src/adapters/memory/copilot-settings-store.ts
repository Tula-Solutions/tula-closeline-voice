import type { CopilotSettings } from 'tula-closeline-contract'
import type { CopilotSettingsStore } from '~/ports/copilot-settings-store'

/** An in-memory {@link CopilotSettingsStore} for tests and local runs. */
export function createMemoryCopilotSettingsStore(): CopilotSettingsStore {
  const byOrganization = new Map<string, CopilotSettings>()
  return {
    async get(organizationId) {
      const settings = byOrganization.get(organizationId)
      return settings === undefined ? undefined : structuredClone(settings)
    },
    async put(organizationId, settings) {
      byOrganization.set(organizationId, structuredClone(settings))
      return structuredClone(settings)
    },
  }
}
