import { formatId } from 'tula-closeline-contract'
import { type Database, withOrganization } from 'tula-closeline-db'
import { voiceCallEvents } from 'tula-closeline-db/schema'
import type { CallEventStore } from '~/ports/call-event-store'

const FOREIGN_KEY_VIOLATION = '23503'

/** Whether Postgres rejected the statement for a missing referenced row, however the driver wraps it. */
function isForeignKeyViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      current.code === FOREIGN_KEY_VIOLATION
    ) {
      return true
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined
  }
  return false
}

/**
 * The Postgres {@link CallEventStore}. The insert runs inside `withOrganization` and uses the
 * unique key on `(organization_id, provider_event_id)`, so a redelivered webhook inserts nothing.
 */
export function createPostgresCallEventStore(db: Database): CallEventStore {
  return {
    async recordProviderCallback(record) {
      try {
        const rows = await withOrganization(db, record.organizationId, (tx) =>
          tx
            .insert(voiceCallEvents)
            .values({
              id: formatId('vev', crypto.randomUUID()),
              organizationId: record.organizationId,
              callId: record.callId,
              kind: 'provider_callback',
              providerEventId: record.providerEventId,
              occurredAt: record.occurredAt,
            })
            .onConflictDoNothing({
              target: [voiceCallEvents.organizationId, voiceCallEvents.providerEventId],
            })
            .returning({ id: voiceCallEvents.id })
        )
        return rows.length === 0 ? 'duplicate' : 'recorded'
      } catch (error) {
        // The Call is not in this Organization (the foreign key to its Calls), so there is no log
        // to append to. Row-level security makes another Organization's Call look the same.
        if (isForeignKeyViolation(error)) {
          return 'unknown_call'
        }
        throw error
      }
    },
  }
}
