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
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const json = JSON.parse(text) as BraveResponse;
        if (json.message) {
          detail = json.message;
        } else if (json.error) {
          detail = json.error;
        }
      } catch {
        // Use raw response text
      }
      throw new Error(`Brave search failed (${response.status} ${response.statusText}): ${detail}`);
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
  }
}
