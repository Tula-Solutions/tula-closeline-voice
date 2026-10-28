import type {
  SearchDocumentsResponse,
  SearchMomentsResponse,
  SearchTurn,
} from 'tula-closeline-contract'

/** A Document passage the Playbook found. */
export type DocumentMatch = SearchDocumentsResponse['items'][number]

/** A won-Deal Moment the Playbook found. */
export type MomentMatch = SearchMomentsResponse['items'][number]

/** What a Moments search found: the matches and the Playbook's own count of Moments and Deals. */
export type MomentSearch = Pick<SearchMomentsResponse, 'items' | 'evidence'>

/** What a Documents search found: the passages, best first, and the Playbook's own counts. */
export type DocumentSearch = Pick<SearchDocumentsResponse, 'items' | 'evidence'>

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
  /**
   * Won-Deal Moments for the latest turns (at most `limit`), with the Playbook's evidence counts. It
   * does not retry; `signal` ends it early. A failure throws.
   */
  searchMoments: (
    organizationId: string,
    turns: readonly SearchTurn[],
    limit: number,
    signal?: AbortSignal
  ) => Promise<MomentSearch>
  /**
   * The best Document passages for the latest turns (at most `limit`), best first. Unlike `search`
   * it does not retry (a live Call cannot wait); `signal` ends it early. A failure throws.
   */
  searchDocuments: (
    organizationId: string,
    turns: readonly SearchTurn[],
    limit: number,
    signal?: AbortSignal
  ) => Promise<DocumentSearch>
}
