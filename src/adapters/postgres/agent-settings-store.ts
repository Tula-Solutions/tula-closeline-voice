import { eq } from 'drizzle-orm'
import { type AgentSettings, agentSettingsSchema } from 'tula-closeline-contract'
import { type Database, type Transaction, withOrganization } from 'tula-closeline-db'
import { voiceAgentSettings } from 'tula-closeline-db/schema'
import { transactionOf } from '~/adapters/postgres/idempotency-store'
import type { AgentSettingsStore } from '~/ports/agent-settings-store'

type Row = typeof voiceAgentSettings.$inferSelect

/** Reads a row through the contract's schema, so a row that breaks the contract fails loudly. */
function toSettings(row: Row): AgentSettings {
  return agentSettingsSchema.parse({
    paused: row.paused,
    greeting: row.greeting,
    voiceStyle: row.voiceStyle,
    timeZone: row.timeZone,
    hours: row.hours,
    maxCallSeconds: row.maxCallSeconds,
    maxCostUsdCents: row.maxCostUsdCents,
    concurrencyCap: row.concurrencyCap,
    languages: ['en'],
    updatedAt: row.updatedAt.toISOString(),
    updatedByMembershipId: row.updatedByMembershipId,
  })
}

/**
 * The Postgres {@link AgentSettingsStore}: every statement runs inside `withOrganization`, so
 * row-level security confines it to the caller's Organization on top of the explicit filter.
 */
export function createPostgresAgentSettingsStore(db: Database): AgentSettingsStore {
  return {
    async get(organizationId) {
      const [row] = await withOrganization(db, organizationId, (tx) =>
        tx
          .select()
          .from(voiceAgentSettings)
          .where(eq(voiceAgentSettings.organizationId, organizationId))
          .limit(1)
      )
      return row === undefined ? undefined : toSettings(row)
    },

    async put(organizationId, settings, within) {
      const values = {
        organizationId,
        paused: settings.paused,
        greeting: settings.greeting,
        voiceStyle: settings.voiceStyle,
        timeZone: settings.timeZone,
        hours: settings.hours,
        maxCallSeconds: settings.maxCallSeconds,
        maxCostUsdCents: settings.maxCostUsdCents,
        concurrencyCap: settings.concurrencyCap,
        updatedAt: new Date(settings.updatedAt),
        updatedByMembershipId: settings.updatedByMembershipId,
      }
      const { organizationId: _organizationId, ...changes } = values
      const write = (tx: Transaction) =>
        tx
          .insert(voiceAgentSettings)
          .values(values)
          .onConflictDoUpdate({ target: voiceAgentSettings.organizationId, set: changes })
          .returning()
      const joined = within === undefined ? undefined : transactionOf(within)
      const [row] = await (joined === undefined
        ? withOrganization(db, organizationId, write)
        : write(joined))
      if (row === undefined) {
        throw new Error('upsert returned no row')
      }
      return toSettings(row)
    },
  }
}
