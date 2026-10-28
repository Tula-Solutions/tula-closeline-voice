import type {
  DocumentMatch,
  Evidence,
  EvidenceSearch,
  MomentMatch,
  MomentSearch,
} from '~/ports/evidence-search'

/** An {@link EvidenceSearch} that also lets a test load what each Organization's Playbook holds. */
export type MemoryEvidenceSearch = EvidenceSearch & {
  /** Sets what searches of `organizationId` find; other Organizations never see it. */
  load: (
    organizationId: string,
    evidence: Partial<Evidence>,
    momentEvidence?: MomentSearch['evidence']
  ) => void
  /** The Organization of every search so far, in order. */
  searched: () => string[]
}

/** An in-memory {@link EvidenceSearch}: it returns what was loaded for the asking Organization only. */
export function createMemoryEvidenceSearch(): MemoryEvidenceSearch {
  const byOrganization = new Map<
    string,
    {
      documents: DocumentMatch[]
      moments: MomentMatch[]
      momentEvidence: MomentSearch['evidence'] | undefined
    }
  >()
  const asked: string[] = []
  return {
    load(organizationId, evidence, momentEvidence) {
      byOrganization.set(organizationId, {
        documents: structuredClone(evidence.documents ?? []),
        moments: structuredClone(evidence.moments ?? []),
        momentEvidence,
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
    async searchDocuments(organizationId, _turns, limit) {
      asked.push(organizationId)
      const all = byOrganization.get(organizationId)?.documents ?? []
      return structuredClone({
        items: all.slice(0, limit),
        evidence: { chunks: all.length, documents: new Set(all.map((d) => d.documentId)).size },
      })
    },
    async searchMoments(organizationId, _turns, limit) {
      asked.push(organizationId)
      const held = byOrganization.get(organizationId)
      const all = held?.moments ?? []
      return structuredClone({
        items: all.slice(0, limit),
        // Unless a test says otherwise the Playbook counts what it holds.
        evidence: held?.momentEvidence ?? {
          moments: all.length,
          deals: new Set(all.map((m) => m.dealRecordId)).size,
        },
      })
    },
  }
}
