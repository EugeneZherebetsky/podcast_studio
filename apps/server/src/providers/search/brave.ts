import type { SearchHit, SearchOptions, SearchProvider } from "./interface.ts";
import { deduplicateHits, formatPublishedDate } from "./url.ts";

export interface BraveSearchOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface BraveWebResultItem {
  title?: string;
  url: string;
  description?: string;
  page_age?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveWebResultItem[];
  };
  message?: string;
  error?: string;
}

function toBraveFreshness(days?: number): "pd" | "pw" | "pm" | "py" | undefined {
  if (days === undefined || days <= 0) return undefined;
  if (days <= 1) return "pd";
  if (days <= 7) return "pw";
  if (days <= 31) return "pm";
  return "py";
}

export class BraveSearchProvider implements SearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: BraveSearchOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.search.brave.com").replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
    let status: number | undefined;
    try {
      const url = new URL(`${this.baseUrl}/res/v1/web/search`);
      url.searchParams.set("q", query);
      // Brave API caps count at 20 per request
      url.searchParams.set("count", String(Math.min(options.max, 20)));

      const freshness = toBraveFreshness(options.freshnessDays);
      if (freshness) {
        url.searchParams.set("freshness", freshness);
      }

      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers: {
          "X-Subscription-Token": this.apiKey,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
          ? response.status : undefined;
        throw new Error("Brave search failed");
      }

      const data = (await response.json()) as BraveResponse;
      const rawResults = data.web?.results ?? [];

      const hits: SearchHit[] = rawResults.map((r) => ({
        title: (r.title ?? "").trim(),
        url: r.url,
        snippet: (r.description ?? "").trim(),
        publishedAt: formatPublishedDate(r.page_age),
      }));

      return deduplicateHits(hits).slice(0, options.max);
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        const safe = new Error(error.name === "AbortError" ? "Search cancelled" : "Search timed out");
        safe.name = error.name;
        throw safe;
      }
      // Do not retain the untrusted exception as a cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(status === undefined ? "Brave search failed" : `Brave search failed (${status})`);
    }
  }
}
