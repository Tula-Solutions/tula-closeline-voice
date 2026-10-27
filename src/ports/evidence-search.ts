import type {
  SearchDocumentsResponse,
  SearchMomentsResponse,
  SearchTurn,
} from 'tula-closeline-contract'

/** A Document passage the Playbook found. */
export type DocumentMatch = SearchDocumentsResponse['items'][number]

/** A won-Deal Moment the Playbook found. */
export type MomentMatch = SearchMomentsResponse['items'][number]

/** What a search for evidence found: Document passages (citable) and won-Deal Moments (wording only). */
export type Evidence = { documents: DocumentMatch[]; moments: MomentMatch[] }

/**
 * Finds the Organization's own sales knowledge that resembles a conversation: the Playbook's
 * `searchDocuments` and `searchMoments`. It reaches only `organizationId`'s Documents. Results are
 * untrusted data. A failure throws; it never returns another Organization's text.
 */
export type EvidenceSearch = {
  /** The best passages and Moments for the latest turns, best first, at most `limit` of each. */
  search: (organizationId: string, turns: readonly SearchTurn[], limit: number) => Promise<Evidence>
}
