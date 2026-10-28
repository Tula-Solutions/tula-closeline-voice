import { formatId } from 'tula-closeline-contract'
import type { ChatSite, ChatSites, ConsentRecorder, ConsentRequest } from '~/ports/chat-sites'

/** The in-memory sites plus the call a test uses to register one. */
export type MemoryChatSites = ChatSites & {
  /** Registers the publishable key of an Organization's site. */
  register: (key: string, site: ChatSite) => void
}

/** Chat sites held in memory, for tests and local runs; unknown keys are unknown. */
export function createMemoryChatSites(): MemoryChatSites {
  const byKey = new Map<string, ChatSite>()
  return {
    register: (key, site) => void byKey.set(key, site),
    async ofKey(key) {
      return byKey.get(key)
    },
    async ofOrganization(organizationId) {
      return [...byKey.values()].find((site) => site.organizationId === organizationId)
    },
  }
}

/** The in-memory recorder plus what it was asked to record. */
export type MemoryConsentRecorder = ConsentRecorder & {
  /** Every request recorded, in order, a repeat of an Idempotency-Key once. */
  recorded: ConsentRequest[]
}

/** A consent recorder held in memory: one Prospect per Organization and phone, one record per key. */
export function createMemoryConsentRecorder(): MemoryConsentRecorder {
  const byKey = new Map<string, { prospectId: string }>()
  const recorded: ConsentRequest[] = []
  return {
    recorded,
    async record(request) {
      const key = `${request.organizationId}\u0000${request.idempotencyKey}`
      const first = byKey.get(key)
      if (first !== undefined) {
        return first
      }
      const result = { prospectId: formatId('prs', crypto.randomUUID()) }
      byKey.set(key, result)
      recorded.push(request)
      return result
    },
  }
}
