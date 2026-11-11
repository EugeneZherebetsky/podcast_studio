/** One web search result; stage `search` turns hits into `candidates.json`. */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  /** ISO 8601 date or date-time, when the engine reports one. */
  publishedAt?: string;
}

export interface SearchOptions {
  /** Maximum number of hits to return. */
  max: number;
  /** Only results published within this many days (recurring topics prefer recent ones). */
  freshnessDays?: number;
}

export interface SearchProvider {
  search(query: string, options: SearchOptions): Promise<SearchHit[]>;
}
