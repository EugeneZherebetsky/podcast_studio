// Stage 3, `extract`: the top N candidates -> sources.json.
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

export interface ExtractInput {
  candidates: Candidates;
  /** How many candidates to try, from the top: 8-12, default 10. */
  maxSources?: number;
  /** Pages fetched at the same time. Default 4. Does not affect the result. */
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
  const limiter = new ConcurrencyLimiter(input.concurrency ?? DEFAULT_CONCURRENCY);

  return runCachedStage({
    workDir: deps.workDir,
    stage: "extract",
    inputs: { candidates: input.candidates, maxSources },
    schema: SourcesSchema,
    run: async () => {
      const top = input.candidates.candidates.slice(0, maxSources);
      const pages = await Promise.all(
        top.map((candidate) =>
          limiter.run(async (): Promise<ExtractedPage | null> => {
            try {
              return await deps.extractor.extract(candidate.url);
            } catch {
              return null; // one unreachable page must not fail the stage
            }
          }),
        ),
      );

      const sources: Source[] = [];
      top.forEach((candidate, i) => {
        const page = pages[i];
        const text = page?.text.trim().slice(0, MAX_SOURCE_TEXT_CHARS).trimEnd() ?? "";
        if (!page || text === "") return;
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

      if (sources.length < MIN_USABLE_SOURCES) {
        throw new Error(
          `Only ${sources.length} usable source${sources.length === 1 ? "" : "s"} found ` +
            `(${top.length} candidate page${top.length === 1 ? "" : "s"} tried, ` +
            `${input.candidates.candidates.length} found by search); at least ` +
            `${MIN_USABLE_SOURCES} are needed. Try a broader topic or brief, or another ` +
            `search provider.`,
        );
      }
      return { artifact: { sources }, usage: [] };
    },
  });
}
