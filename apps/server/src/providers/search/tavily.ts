import type { SearchHit, SearchOptions, SearchProvider } from "./interface.ts";
import { deduplicateHits, formatPublishedDate } from "./url.ts";

export interface TavilySearchOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface TavilyResultItem {
  title?: string;
  url: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResultItem[];
  detail?: { error?: string };
  message?: string;
}

function toTavilyTimeRange(days?: number): "day" | "week" | "month" | "year" | undefined {
  if (days === undefined || days <= 0) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "year";
}

export class TavilySearchProvider implements SearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: TavilySearchOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
    const timeRange = toTavilyTimeRange(options.freshnessDays);

    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query,
      max_results: options.max,
      include_published_date: true,
    };
    if (timeRange) {
      body.time_range = timeRange;
    }

    const response = await this.fetchFn(`${this.baseUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const json = JSON.parse(text) as TavilyResponse;
        if (json.detail?.error) {
          detail = json.detail.error;
        } else if (json.message) {
          detail = json.message;
        }
      } catch {
        // Use raw response text
      }
      throw new Error(`Tavily search failed (${response.status} ${response.statusText}): ${detail}`);
    }

    const data = (await response.json()) as TavilyResponse;
    if (!Array.isArray(data.results)) {
      throw new Error("Tavily search failed: response missing results array");
    }

    const hits: SearchHit[] = data.results.map((r) => ({
      title: (r.title ?? "").trim(),
      url: r.url,
      snippet: (r.content ?? "").trim(),
      publishedAt: formatPublishedDate(r.published_date),
    }));

    return deduplicateHits(hits).slice(0, options.max);
  }
}
