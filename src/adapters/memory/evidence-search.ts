import type { DocumentMatch, Evidence, EvidenceSearch, MomentMatch } from '~/ports/evidence-search'

/** An {@link EvidenceSearch} that also lets a test load what each Organization's Playbook holds. */
export type MemoryEvidenceSearch = EvidenceSearch & {
  /** Sets what searches of `organizationId` find; other Organizations never see it. */
  load: (organizationId: string, evidence: Partial<Evidence>) => void
  /** The Organization of every search so far, in order. */
  searched: () => string[]
}

/** An in-memory {@link EvidenceSearch}: it returns what was loaded for the asking Organization only. */
export function createMemoryEvidenceSearch(): MemoryEvidenceSearch {
  const byOrganization = new Map<string, { documents: DocumentMatch[]; moments: MomentMatch[] }>()
  const asked: string[] = []
  return {
    load(organizationId, evidence) {
      byOrganization.set(organizationId, {
        documents: structuredClone(evidence.documents ?? []),
        moments: structuredClone(evidence.moments ?? []),
      })
    },
    searched: () => [...asked],
    async search(organizationId, _turns, limit) {
      asked.push(organizationId)
      const held = byOrganization.get(organizationId)
      return {
        documents: structuredClone((held?.documents ?? []).slice(0, limit)),
        moments: structuredClone((held?.moments ?? []).slice(0, limit)),
      }
    },
  }
}
