import type { AgentSettings } from 'tula-closeline-contract'
import type { AgentSettingsStore } from '~/ports/agent-settings-store'

/** An in-memory {@link AgentSettingsStore} for tests and local runs. */
export function createMemoryAgentSettingsStore(): AgentSettingsStore {
  const byOrganization = new Map<string, AgentSettings>()
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
