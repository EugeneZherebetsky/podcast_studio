// Stage 2, `search`: the plan's queries -> candidates.json.
import type { SearchHit, SearchProvider } from "../providers/search/interface.ts";
import { canonicalizeUrl, deduplicateHits } from "../providers/search/url.ts";
import { runCachedStage, type StageResult } from "./artifacts.ts";
import { CandidatesSchema, type Candidates, type Plan } from "./schemas.ts";

export interface SearchInput {
  plan: Plan;
  /** URLs earlier episodes of this topic already used (`used_sources`); they are dropped. */
  usedUrls?: Iterable<string>;
  /** Hits requested per query. Default 8. */
  maxResultsPerQuery?: number;
  /** Recurring topics prefer recent results: only hits from the last N days. */
  freshnessDays?: number;
}

export interface SearchDeps {
  workDir: string;
  search: SearchProvider;
}

const DEFAULT_MAX_RESULTS_PER_QUERY = 8;

function canonicalOrRaw(url: string): string {
  try {
    return canonicalizeUrl(url);
  } catch {
    return url.trim();
  }
}

/**
 * Takes the best hit of every query before the second-best of any, so the candidates that
 * stage `extract` picks from the top cover all the queries.
 */
function interleave(perQuery: readonly (readonly SearchHit[])[]): SearchHit[] {
  const longest = Math.max(0, ...perQuery.map((hits) => hits.length));
  const merged: SearchHit[] = [];
  for (let rank = 0; rank < longest; rank++) {
    for (const hits of perQuery) {
      const hit = hits[rank];
      if (hit) merged.push(hit);
    }
  }
  return merged;
}

export async function runSearchStage(
  deps: SearchDeps,
  input: SearchInput,
): Promise<StageResult<Candidates>> {
  const max = input.maxResultsPerQuery ?? DEFAULT_MAX_RESULTS_PER_QUERY;
  const used = new Set([...(input.usedUrls ?? [])].map(canonicalOrRaw));
  const options =
    input.freshnessDays === undefined ? { max } : { max, freshnessDays: input.freshnessDays };

  return runCachedStage({
    workDir: deps.workDir,
    stage: "search",
    inputs: { plan: input.plan, usedUrls: [...used].sort(), options },
    schema: CandidatesSchema,
    run: async () => {
      const perQuery: SearchHit[][] = [];
      for (const query of input.plan.queries) {
        perQuery.push(await deps.search.search(query, { ...options }));
      }
      const candidates = deduplicateHits(interleave(perQuery))
        .filter((hit) => !used.has(hit.url))
        .map((hit) => ({
          url: hit.url,
          title: hit.title,
          snippet: hit.snippet,
          ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
        }));
      return { artifact: { candidates }, usage: [] };
    },
  });
}
