import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { createSearchProvider } from "../src/providers/index.ts";
import { BraveSearchProvider } from "../src/providers/search/brave.ts";
import { SearxngSearchProvider } from "../src/providers/search/searxng.ts";
import { TavilySearchProvider } from "../src/providers/search/tavily.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TAVILY_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures/tavily-response.json"), "utf8"),
);
const BRAVE_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures/brave-response.json"), "utf8"),
);
const SEARXNG_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures/searxng-response.json"), "utf8"),
);

describe("TavilySearchProvider", () => {
  test("sends POST request with query, api_key, max_results, and parses results", async () => {
    let capturedUrl = "";
    let capturedOptions: RequestInit | undefined;

    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      capturedUrl = String(input);
      capturedOptions = init;
      return new Response(JSON.stringify(TAVILY_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const provider = new TavilySearchProvider({
      apiKey: "tvly-secret-123",
      fetch: mockFetch,
    });

    const hits = await provider.search("podcast", { max: 5 });

    expect(capturedUrl).toBe("https://api.tavily.com/search");
    expect(capturedOptions?.method).toBe("POST");
    expect(capturedOptions?.headers).toMatchObject({
      "Content-Type": "application/json",
    });

    const body = JSON.parse(String(capturedOptions?.body));
    expect(body).toEqual({
      api_key: "tvly-secret-123",
      query: "podcast",
      max_results: 5,
      include_published_date: true,
    });

    // Fixture had 3 items with 1 duplicate canonical URL (wikipedia)
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://en.wikipedia.org/wiki/Podcasting",
      title: "Podcasting - Wikipedia",
      snippet:
        "A podcast is an episodic series of spoken word digital audio files that a user can download to a personal device for easy listening.",
      publishedAt: "2026-03-01T12:00:00.000Z",
    });
    expect(hits[1]?.url).toBe("https://example.com/history-of-podcasting");
    expect(hits[1]?.publishedAt).toBe("2026-02-15T10:00:00.000Z");
  });

  test("maps freshnessDays to time_range", async () => {
    const bodies: unknown[] = [];
    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    const provider = new TavilySearchProvider({ apiKey: "key", fetch: mockFetch });

    await provider.search("q", { max: 2, freshnessDays: 1 });
    await provider.search("q", { max: 2, freshnessDays: 7 });
    await provider.search("q", { max: 2, freshnessDays: 30 });
    await provider.search("q", { max: 2, freshnessDays: 90 });
    await provider.search("q", { max: 2 });

    expect(bodies).toEqual([
      expect.objectContaining({ time_range: "day" }),
      expect.objectContaining({ time_range: "week" }),
      expect.objectContaining({ time_range: "month" }),
      expect.objectContaining({ time_range: "year" }),
      expect.not.objectContaining({ time_range: expect.anything() }),
    ]);
  });

  test("handles HTTP errors with clear message", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ detail: { error: "Invalid API key" } }), {
        status: 401,
        statusText: "Unauthorized",
      });
    });

    const provider = new TavilySearchProvider({ apiKey: "bad-key", fetch: mockFetch });
    await expect(provider.search("q", { max: 5 })).rejects.toThrowError(
      /Tavily search failed \(401 Unauthorized\): Invalid API key/,
    );
  });

  test("handles missing results array gracefully", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ something: "else" }), { status: 200 });
    });

    const provider = new TavilySearchProvider({ apiKey: "key", fetch: mockFetch });
    await expect(provider.search("q", { max: 5 })).rejects.toThrowError(
      /Tavily search failed: response missing results array/,
    );
  });
});

describe("BraveSearchProvider", () => {
  test("sends GET request with X-Subscription-Token header, query params, and parses results", async () => {
    let capturedUrl = "";
    let capturedOptions: RequestInit | undefined;

    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      capturedUrl = String(input);
      capturedOptions = init;
      return new Response(JSON.stringify(BRAVE_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const provider = new BraveSearchProvider({
      apiKey: "brave-secret-456",
      fetch: mockFetch,
    });

    const hits = await provider.search("podcast", { max: 10 });

    const parsedUrl = new URL(capturedUrl);
    expect(parsedUrl.origin + parsedUrl.pathname).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(parsedUrl.searchParams.get("q")).toBe("podcast");
    expect(parsedUrl.searchParams.get("count")).toBe("10");
    expect(capturedOptions?.method ?? "GET").toBe("GET");
    expect(capturedOptions?.headers).toMatchObject({
      "X-Subscription-Token": "brave-secret-456",
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://en.wikipedia.org/wiki/Podcasting",
      title: "Podcasting - Wikipedia",
      snippet:
        "A podcast is an episodic series of digital audio files that a user can download.",
      publishedAt: "2026-01-15T00:00:00.000Z",
    });
    expect(hits[1]?.url).toBe("https://example.org/guides/start-a-podcast");
    expect(hits[1]?.publishedAt).toBe("2026-02-10T08:00:00.000Z");
  });

  test("maps freshnessDays to freshness parameter (pd, pw, pm, py)", async () => {
    const urls: string[] = [];
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    });

    const provider = new BraveSearchProvider({ apiKey: "key", fetch: mockFetch });

    await provider.search("q", { max: 2, freshnessDays: 1 });
    await provider.search("q", { max: 2, freshnessDays: 7 });
    await provider.search("q", { max: 2, freshnessDays: 31 });
    await provider.search("q", { max: 2, freshnessDays: 60 });
    await provider.search("q", { max: 2 });

    const freshnessValues = urls.map((u) => new URL(u).searchParams.get("freshness"));
    expect(freshnessValues).toEqual(["pd", "pw", "pm", "py", null]);
  });

  test("handles empty or missing web results without error", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const provider = new BraveSearchProvider({ apiKey: "key", fetch: mockFetch });
    const hits = await provider.search("q", { max: 5 });
    expect(hits).toEqual([]);
  });

  test("handles HTTP errors with clear message", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ message: "Subscription limit reached" }), {
        status: 429,
        statusText: "Too Many Requests",
      });
    });

    const provider = new BraveSearchProvider({ apiKey: "key", fetch: mockFetch });
    await expect(provider.search("q", { max: 5 })).rejects.toThrowError(
      /Brave search failed \(429 Too Many Requests\): Subscription limit reached/,
    );
  });
});

describe("SearxngSearchProvider", () => {
  test("sends GET request to /search with format=json and categories=general", async () => {
    let capturedUrl = "";

    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(SEARXNG_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const provider = new SearxngSearchProvider({
      baseUrl: "http://localhost:8888",
      fetch: mockFetch,
    });

    const hits = await provider.search("podcast", { max: 5 });

    const parsedUrl = new URL(capturedUrl);
    expect(parsedUrl.origin + parsedUrl.pathname).toBe("http://localhost:8888/search");
    expect(parsedUrl.searchParams.get("q")).toBe("podcast");
    expect(parsedUrl.searchParams.get("format")).toBe("json");
    expect(parsedUrl.searchParams.get("categories")).toBe("general");

    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://en.wikipedia.org/wiki/Podcasting",
      title: "Podcasting - Wikipedia",
      snippet: "A podcast is a digital audio program made available on the Internet.",
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(hits[1]?.url).toBe("https://example.net/podcasts/overview");
  });

  test("maps freshnessDays to time_range (day, week, month, year)", async () => {
    const urls: string[] = [];
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    const provider = new SearxngSearchProvider({
      baseUrl: "http://localhost:8888",
      fetch: mockFetch,
    });

    await provider.search("q", { max: 2, freshnessDays: 1 });
    await provider.search("q", { max: 2, freshnessDays: 7 });
    await provider.search("q", { max: 2, freshnessDays: 30 });
    await provider.search("q", { max: 2, freshnessDays: 90 });
    await provider.search("q", { max: 2 });

    const timeRangeValues = urls.map((u) => new URL(u).searchParams.get("time_range"));
    expect(timeRangeValues).toEqual(["day", "week", "month", "year", null]);
  });

  test("handles HTTP errors with clear message", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response("Service Unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      });
    });

    const provider = new SearxngSearchProvider({
      baseUrl: "http://localhost:8888",
      fetch: mockFetch,
    });
    await expect(provider.search("q", { max: 5 })).rejects.toThrowError(
      /SearXNG search failed \(503 Service Unavailable\): Service Unavailable/,
    );
  });

  test("handles missing results array gracefully", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ error: "Something bad happened" }), {
        status: 200,
      });
    });

    const provider = new SearxngSearchProvider({
      baseUrl: "http://localhost:8888",
      fetch: mockFetch,
    });
    await expect(provider.search("q", { max: 5 })).rejects.toThrowError(
      /SearXNG search failed: response missing results array/,
    );
  });
});

describe("createSearchProvider", () => {
  test("throws clear error naming TAVILY_API_KEY when missing", () => {
    const config = parseConfig({ SEARCH_PROVIDER: "tavily" });
    expect(() => createSearchProvider(config)).toThrowError(
      /Cannot use the "tavily" search provider: TAVILY_API_KEY is not set/,
    );
  });

  test("throws clear error naming BRAVE_API_KEY when missing", () => {
    const config = parseConfig({ SEARCH_PROVIDER: "brave" });
    expect(() => createSearchProvider(config)).toThrowError(
      /Cannot use the "brave" search provider: BRAVE_API_KEY is not set/,
    );
  });

  test("constructs TavilySearchProvider when TAVILY_API_KEY is present", () => {
    const config = parseConfig({
      SEARCH_PROVIDER: "tavily",
      TAVILY_API_KEY: "tvly-test",
    });
    const provider = createSearchProvider(config);
    expect(provider).toBeInstanceOf(TavilySearchProvider);
  });

  test("constructs BraveSearchProvider when BRAVE_API_KEY is present", () => {
    const config = parseConfig({
      SEARCH_PROVIDER: "brave",
      BRAVE_API_KEY: "brave-test",
    });
    const provider = createSearchProvider(config);
    expect(provider).toBeInstanceOf(BraveSearchProvider);
  });

  test("constructs SearxngSearchProvider when SEARCH_PROVIDER is searxng", () => {
    const config = parseConfig({
      SEARCH_PROVIDER: "searxng",
      SEARXNG_URL: "http://localhost:8888",
    });
    const provider = createSearchProvider(config);
    expect(provider).toBeInstanceOf(SearxngSearchProvider);
  });
});
