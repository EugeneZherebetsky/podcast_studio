// Stage 3, `extract`: ranked candidates -> sources.json.
import type { ExtractedPage, Extractor } from "../providers/extract/interface.ts";
import { ConcurrencyLimiter } from "../providers/tts/cache.ts";
import { runCachedStage, type StageResult } from "./artifacts.ts";
import {
  MAX_SOURCE_TEXT_CHARS,
  MIN_USABLE_SOURCES,
  SourcesSchema,
  type Candidates,
  type Source,
  type Sources,
} from "./schemas.ts";

export const MIN_EXTRACT_CANDIDATES = 8;
export const MAX_EXTRACT_CANDIDATES = 12;
export const DEFAULT_EXTRACT_CANDIDATES = 10;
const DEFAULT_CONCURRENCY = 4;
const MAX_CANDIDATE_ATTEMPTS = 40;
// A length/access-wall heuristic excludes obvious stubs, not unreliable facts.
const MIN_READABLE_CHARS = 200;
// A practical research-text target, not a guarantee of factual quality.
const TARGET_READABLE_CHARS = 12_000;
const ACCESS_WALL =
  /^(?:(?:subscribe|sign in|log in|register)\s+to\s+(?:continue|read|access)\b|(?:please\s+)?enable\s+javascript\b)/i;

export interface ExtractInput {
  candidates: Candidates;
  /** Maximum successfully extracted sources: 8-12, default 10. */
  maxSources?: number;
  /** Pages fetched at the same time, capped at 4. */
  concurrency?: number;
}

export interface ExtractDeps {
  workDir: string;
  extractor: Extractor;
}

function checkMaxSources(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_EXTRACT_CANDIDATES ||
    value > MAX_EXTRACT_CANDIDATES
  ) {
    throw new Error(
      `Invalid maxSources: expected an integer from ${MIN_EXTRACT_CANDIDATES} to ` +
        `${MAX_EXTRACT_CANDIDATES}, got ${value}`,
    );
  }
  return value;
}

export async function runExtractStage(
  deps: ExtractDeps,
  input: ExtractInput,
): Promise<StageResult<Sources>> {
  const maxSources = checkMaxSources(input.maxSources ?? DEFAULT_EXTRACT_CANDIDATES);
  if (
    !Number.isInteger(input.concurrency ?? DEFAULT_CONCURRENCY) ||
    (input.concurrency ?? DEFAULT_CONCURRENCY) < 1
  ) {
    throw new Error("Invalid extract concurrency: expected a positive integer");
  }
  const concurrency = Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY);
  const limiter = new ConcurrencyLimiter(concurrency);

  return runCachedStage({
    workDir: deps.workDir,
    stage: "extract",
    inputs: { candidates: input.candidates, maxSources, concurrency, extractionVersion: 2 },
    schema: SourcesSchema,
    run: async () => {
      const top = input.candidates.candidates.slice(0, MAX_CANDIDATE_ATTEMPTS);
      const sources: Source[] = [];
      let attempted = 0;
      while (attempted < top.length && sources.length < maxSources) {
        const batch = top.slice(
          attempted,
          attempted + Math.min(concurrency, maxSources - sources.length),
        );
        attempted += batch.length;
        const pages = await Promise.all(
          batch.map((candidate) =>
            limiter.run(async (): Promise<ExtractedPage | null> => {
              try {
                return await deps.extractor.extract(candidate.url);
              } catch {
                return null; // one unreachable page must not fail the stage
              }
            }),
          ),
        );
        batch.forEach((candidate, i) => {
          const page = pages[i];
          const text = page?.text.trim().slice(0, MAX_SOURCE_TEXT_CHARS).trimEnd() ?? "";
          if (
            !page ||
            text.replace(/\s+/g, " ").length < MIN_READABLE_CHARS ||
            ACCESS_WALL.test(text)
          )
            return;
          const publishedAt = page.publishedAt ?? candidate.publishedAt;
          sources.push({
            id: `s${sources.length + 1}`,
            url: candidate.url,
            title: page.title.trim() || candidate.title.trim() || candidate.url,
            site: page.site,
            ...(publishedAt ? { publishedAt } : {}),
            text,
          });
        });
        if (
          sources.length >= MIN_USABLE_SOURCES &&
          sources.reduce((total, source) => total + source.text.length, 0) >= TARGET_READABLE_CHARS
        )
          break;
      }
      console.info(`[extract] attempted ${attempted}, usable ${sources.length}`);

      if (sources.length < MIN_USABLE_SOURCES) {
        throw new Error(
          `Only ${sources.length} usable source${sources.length === 1 ? "" : "s"} found ` +
            `(${attempted} candidate page${attempted === 1 ? "" : "s"} tried, ` +
            `${input.candidates.candidates.length} found by search); at least ` +
            `${MIN_USABLE_SOURCES} are needed. Try a broader topic or brief, or another ` +
            `search provider.`,
        );
      }
      return { artifact: { sources }, usage: [] };
    },
  });
}
