import { eq } from 'drizzle-orm'
import { type CopilotSettings, copilotSettingsSchema } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceCopilotSettings } from 'tula-closeline-db/schema'
import type { CopilotSettingsStore } from '~/ports/copilot-settings-store'

type Row = typeof voiceCopilotSettings.$inferSelect

/** Reads a row through the contract's schema, so a row that breaks the contract fails loudly. */
function toSettings(row: Row): CopilotSettings {
  return copilotSettingsSchema.parse({
    enabled: row.enabled,
    minMoments: row.minMoments,
    minDeals: row.minDeals,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedByMembershipId,
  })
}

/** The Postgres {@link CopilotSettingsStore}; every statement runs inside `withOrganization`. */
export function createPostgresCopilotSettingsStore(db: Database): CopilotSettingsStore {
  return {
    async get(organizationId) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceCopilotSettings)
          .where(eq(voiceCopilotSettings.organizationId, organizationId))
          .limit(1)
      )
      return row === undefined ? undefined : toSettings(row)
    },

    async put(organizationId, settings) {
      const changes = {
        enabled: settings.enabled,
        minMoments: settings.minMoments,
        minDeals: settings.minDeals,
        updatedAt: new Date(settings.updatedAt ?? Date.now()),
        updatedByMembershipId: settings.updatedBy,
      }
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .insert(voiceCopilotSettings)
          .values({ organizationId, ...changes })
          .onConflictDoUpdate({ target: voiceCopilotSettings.organizationId, set: changes })
          .returning()
      )
      if (row === undefined) {
        throw new Error('upsert returned no row')
      }
      return toSettings(row)
    },
  }
}
