import type { SearchHit, SearchOptions, SearchProvider } from "./interface.ts";
import { localServiceUrl } from "../local-url.ts";
import { deduplicateHits, formatPublishedDate } from "./url.ts";

export interface SearxngSearchOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

interface SearxngResultItem {
  title?: string;
  url: string;
  content?: string;
  publishedDate?: string;
  published_date?: string;
}

interface SearxngResponse {
  results?: SearxngResultItem[];
  error?: string;
}

function toSearxngTimeRange(days?: number): "day" | "week" | "month" | "year" | undefined {
  if (days === undefined || days <= 0) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "year";
}

export class SearxngSearchProvider implements SearchProvider {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: SearxngSearchOptions) {
    this.baseUrl = localServiceUrl(options.baseUrl).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
    let status: number | undefined;
    let missingResults = false;
    try {
      const url = new URL(`${this.baseUrl}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("categories", "general");

      const timeRange = toSearxngTimeRange(options.freshnessDays);
      if (timeRange) {
        url.searchParams.set("time_range", timeRange);
      }

      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        status =
          Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status
            : undefined;
        throw new Error("SearXNG search failed");
      }

      const data = (await response.json()) as SearxngResponse;
      if (!Array.isArray(data.results)) {
        missingResults = true;
        throw new Error("SearXNG search failed");
      }

      const hits: SearchHit[] = data.results.map((r) => ({
        title: (r.title ?? "").trim(),
        url: r.url,
        snippet: (r.content ?? "").trim(),
        publishedAt: formatPublishedDate(r.publishedDate ?? r.published_date),
      }));

      return deduplicateHits(hits).slice(0, options.max);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        const safe = new Error(
          error.name === "AbortError" ? "Search cancelled" : "Search timed out",
        );
        safe.name = error.name;
        throw safe;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        missingResults
          ? "SearXNG search failed: response missing results array"
          : status === undefined
            ? "SearXNG search failed"
            : `SearXNG search failed (${status})`,
      );
    }
  }
}
