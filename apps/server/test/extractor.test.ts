import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  ReadabilityExtractor,
  trimToParagraphBoundary,
} from "../src/providers/extract/readability.ts";
import {
  type DnsLookupFn,
  isBlockedIp,
  validateUrlForSsrf,
} from "../src/providers/extract/ssrf.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARTICLE_HTML = readFileSync(path.join(__dirname, "fixtures/article.html"), "utf8");
const PAYWALL_STUB_HTML = readFileSync(path.join(__dirname, "fixtures/paywall-stub.html"), "utf8");
const NON_HTML_TXT = readFileSync(path.join(__dirname, "fixtures/non-html.txt"), "utf8");

describe("SSRF and IP validation", () => {
  test("blocks loopback IPv4 addresses", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.0.0.2")).toBe(true);
    expect(isBlockedIp("127.255.255.255")).toBe(true);
  });

  test("blocks link-local IPv4 addresses", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("169.254.1.1")).toBe(true);
  });

  test("blocks private IPv4 networks (10/8, 172.16/12, 192.168/16)", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("10.255.255.255")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("192.168.0.100")).toBe(true);
  });

  test("blocks 0.0.0.0/8, multicast, and broadcast", () => {
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("224.0.0.1")).toBe(true);
    expect(isBlockedIp("255.255.255.255")).toBe(true);
  });

  test("blocks loopback and link-local IPv6 addresses", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fe80::abcd:1234")).toBe(true);
  });

  test("blocks unique local / private IPv6 (fc00::/7)", () => {
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456:789a::1")).toBe(true);
  });

  test("blocks IPv4-mapped private IPv6 addresses", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:192.168.1.1")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });

  test("returns the validated address for the connection rather than resolving again", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const result = await validateUrlForSsrf("https://example.com/", lookup);
    expect(result).toMatchObject({ allowed: true, address: { address: "8.8.8.8", family: 4 } });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("rejects mixed public and private DNS answers and reserved ranges", async () => {
    expect(
      (
        await validateUrlForSsrf("https://example.com", async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "::1", family: 6 },
        ])
      ).allowed,
    ).toBe(false);
    for (const ip of ["198.18.0.1", "2001:db8::1", "2002:7f00:1::"])
      expect(isBlockedIp(ip)).toBe(true);
  });

  test("rejects a rebinding hostname on a redirect before contacting it", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/next" } }),
    );
    expect(
      await new ReadabilityExtractor({ lookup, fetch }).extract("https://news.example.com/start"),
    ).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test("allows public IP addresses", () => {
    expect(isBlockedIp("93.184.216.34")).toBe(false);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  test("refuses non-http(s) schemes and loopback URLs without DNS lookup", async () => {
    const mockLookup = vi.fn();
    const resFile = await validateUrlForSsrf("file:///etc/passwd", mockLookup);
    expect(resFile.allowed).toBe(false);

    const resFtp = await validateUrlForSsrf("ftp://example.com/file", mockLookup);
    expect(resFtp.allowed).toBe(false);

    const resLoopback = await validateUrlForSsrf("http://127.0.0.1/admin", mockLookup);
    expect(resLoopback.allowed).toBe(false);

    const resLinkLocal = await validateUrlForSsrf("http://169.254.169.254/meta", mockLookup);
    expect(resLinkLocal.allowed).toBe(false);

    const resLocalhost = await validateUrlForSsrf("http://localhost:8080/test", mockLookup);
    expect(resLocalhost.allowed).toBe(false);

    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe("ReadabilityExtractor SSRF enforcement", () => {
  test("refuses http://127.0.0.1 without fetching", async () => {
    const mockFetch = vi.fn();
    const extractor = new ReadabilityExtractor({ fetch: mockFetch });
    const result = await extractor.extract("http://127.0.0.1/secret");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("refuses http://169.254.169.254 without fetching", async () => {
    const mockFetch = vi.fn();
    const extractor = new ReadabilityExtractor({ fetch: mockFetch });
    const result = await extractor.extract("http://169.254.169.254/latest/meta-data");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("refuses file:///etc/passwd without fetching", async () => {
    const mockFetch = vi.fn();
    const extractor = new ReadabilityExtractor({ fetch: mockFetch });
    const result = await extractor.extract("file:///etc/passwd");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("refuses IPv6 loopback and link-local URLs without fetching", async () => {
    const mockFetch = vi.fn();
    const extractor = new ReadabilityExtractor({ fetch: mockFetch });
    expect(await extractor.extract("http://[::1]/secret")).toBeNull();
    expect(await extractor.extract("http://[fe80::1]/secret")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("refuses private hostnames that resolve to private IPs without fetching", async () => {
    const mockFetch = vi.fn();
    const mockLookup: DnsLookupFn = vi.fn(async () => [{ address: "192.168.1.100", family: 4 }]);
    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: mockLookup,
    });

    const result = await extractor.extract("https://internal.corp/secret");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("refuses redirects pointing to private addresses", async () => {
    const mockLookup: DnsLookupFn = vi.fn(async (host: string) => {
      if (host === "public.example.com") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "127.0.0.1", family: 4 }];
    });

    const mockFetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/admin" },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: mockLookup,
    });

    const result = await extractor.extract("https://public.example.com/redirect");
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("ReadabilityExtractor HTML fixtures", () => {
  const publicLookup: DnsLookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

  test("extracts title, text, site, and publishedAt from standard article fixture", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(ARTICLE_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });

    const result = await extractor.extract("https://news.example.com/2026/bees");
    expect(result).not.toBeNull();
    expect(result?.title).toBe("The Secret Life of Honeybees");
    expect(result?.site).toBe("Science Daily");
    expect(result?.publishedAt).toBe("2026-05-15T10:30:00.000Z");
    expect(result?.text).toContain("Honeybees are among the most remarkable");
    expect(result?.text).toContain("worker bees perform a variety");
  });

  test("returns null for paywall / stub page where Readability yields no usable article", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(PAYWALL_STUB_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });

    const result = await extractor.extract("https://news.example.com/stub");
    expect(result).toBeNull();
  });

  test("returns null for non-HTML Content-Type (e.g. JSON or binary)", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response('{"error": "not found"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });

    const result = await extractor.extract("https://news.example.com/data.json");
    expect(result).toBeNull();
  });

  test("returns null for saved non-HTML fixture", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(NON_HTML_TXT, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });

    const result = await extractor.extract("https://news.example.com/file.txt");
    expect(result).toBeNull();
  });

  test("sends configured User-Agent header with fetch request", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(ARTICLE_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });
    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });
    await extractor.extract("https://news.example.com/bees");
    expect(capturedHeaders?.["User-Agent"]).toContain("PodcastStudio/1.0 (article reader)");
  });

  test("returns null when fetch exceeds timeout", async () => {
    const mockFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted by timeout"));
          });
        }),
    );
    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
      timeoutMs: 30,
    });
    const result = await extractor.extract("https://news.example.com/slow");
    expect(result).toBeNull();
  });

  test("trims article text exceeding 8000 chars at paragraph boundary in extract()", async () => {
    const p1 = "First paragraph content. ".repeat(150); // ~3750 chars
    const p2 = "Second paragraph content. ".repeat(150); // ~3900 chars
    const p3 = "Third paragraph content. ".repeat(150); // ~3900 chars
    const longHtml = `<!DOCTYPE html><html><head><title>Long Read</title></head><body><article><h1>Long Read</h1><p>${p1}</p><p>${p2}</p><p>${p3}</p></article></body></html>`;

    const mockFetch = vi.fn(async () => {
      return new Response(longHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });
    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });
    const result = await extractor.extract("https://news.example.com/long");
    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(8000);
    expect(result!.text).toContain("First paragraph content.");
    expect(result!.text).toContain("Second paragraph content.");
    expect(result!.text).not.toContain("Third paragraph content.");
  });

  test("returns null for 404 or 500 HTTP errors", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });

    const result = await extractor.extract("https://news.example.com/missing");
    expect(result).toBeNull();
  });
});

describe("ReadabilityExtractor size cap enforcement", () => {
  const publicLookup: DnsLookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

  test("refuses response when Content-Length header exceeds 5 MB", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response("too big", {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "Content-Length": String(6 * 1024 * 1024),
        },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });

    const result = await extractor.extract("https://news.example.com/huge");
    expect(result).toBeNull();
  });

  test("aborts response when streaming body exceeds 5 MB", async () => {
    // 6 MB chunk
    const bigChunk = new Uint8Array(6 * 1024 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });

    const mockFetch = vi.fn(async () => {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });

    const result = await extractor.extract("https://news.example.com/stream-huge");
    expect(result).toBeNull();
  });
});

describe("trimToParagraphBoundary", () => {
  test("returns text unchanged if length <= maxChars", () => {
    const short = "This is a short article paragraph.";
    expect(trimToParagraphBoundary(short, 8000)).toBe(short);
  });

  test("trims at double newline (paragraph boundary) under 8000 characters", () => {
    const para1 = "A".repeat(4000);
    const para2 = "B".repeat(3500);
    const para3 = "C".repeat(2000);
    const full = `${para1}\n\n${para2}\n\n${para3}`;
    expect(full.length).toBe(9504);

    const trimmed = trimToParagraphBoundary(full, 8000);
    expect(trimmed.length).toBeLessThanOrEqual(8000);
    expect(trimmed).toBe(`${para1}\n\n${para2}`);
  });

  test("trims at single newline if no double newline under maxChars", () => {
    const line1 = "A".repeat(4500);
    const line2 = "B".repeat(3000);
    const line3 = "C".repeat(2000);
    const full = `${line1}\n${line2}\n${line3}`;

    const trimmed = trimToParagraphBoundary(full, 8000);
    expect(trimmed.length).toBeLessThanOrEqual(8000);
    expect(trimmed).toBe(`${line1}\n${line2}`);
  });

  test("trims at space if no newlines exist", () => {
    const part1 = "A".repeat(7000);
    const part2 = "B".repeat(2000);
    const full = `${part1} ${part2}`;

    const trimmed = trimToParagraphBoundary(full, 8000);
    expect(trimmed.length).toBeLessThanOrEqual(8000);
    expect(trimmed).toBe(part1);
  });
});

describe("Date extraction variants", () => {
  const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

  test("extracts published date from schema.org JSON-LD", async () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>JSON-LD Article</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": "JSON-LD Article",
    "datePublished": "2025-11-20T14:45:00+01:00"
  }
  </script>
</head>
<body>
  <article>
    <h1>JSON-LD Article</h1>
    <p>This is paragraph one of the article text with enough content to be an article.</p>
    <p>This is paragraph two providing additional context and information for the parser.</p>
  </article>
</body>
</html>`;

    const mockFetch = vi.fn(async () => {
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    const extractor = new ReadabilityExtractor({
      fetch: mockFetch,
      lookup: publicLookup,
    });

    const result = await extractor.extract("https://news.example.com/jsonld");
    expect(result).not.toBeNull();
    expect(result?.publishedAt).toBe(new Date("2025-11-20T14:45:00+01:00").toISOString());
  });
});
