import { FAKE_SEARCH_HITS } from "../fixtures.ts";
import type { SearchHit, SearchOptions, SearchProvider } from "./interface.ts";

export interface FakeSearchOptions {
  /** Hits for any query without an entry in `byQuery`. Default: `FAKE_SEARCH_HITS`. */
  hits?: readonly SearchHit[];
  /** Hits for exact query strings. */
  byQuery?: Readonly<Record<string, readonly SearchHit[]>>;
}

/** Returns canned hits (the first `max` of them) and records every call. */
export class FakeSearchProvider implements SearchProvider {
  readonly calls: { query: string; options: SearchOptions }[] = [];
  private readonly hits: readonly SearchHit[];
  private readonly byQuery: Readonly<Record<string, readonly SearchHit[]>>;

  constructor(options: FakeSearchOptions = {}) {
    this.hits = options.hits ?? FAKE_SEARCH_HITS;
    this.byQuery = options.byQuery ?? {};
  }

  async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
    this.calls.push({ query, options: { ...options } });
    const hits = Object.hasOwn(this.byQuery, query) ? this.byQuery[query]! : this.hits;
    return hits.slice(0, Math.max(0, options.max)).map((hit) => ({ ...hit }));
  }
}
