import { describe, expect, test } from "vitest";
import type { SearchHit } from "../src/providers/search/interface.ts";
import { canonicalizeUrl, deduplicateHits } from "../src/providers/search/url.ts";

describe("canonicalizeUrl", () => {
  test("strips fragment/hash", () => {
    expect(canonicalizeUrl("https://example.com/article#intro")).toBe(
      "https://example.com/article",
    );
  });

  test("normalises scheme and hostname to lowercase", () => {
    expect(canonicalizeUrl("HTTPS://WWW.Example.COM/Article")).toBe(
      "https://www.example.com/Article",
    );
  });

  test("removes default ports (:80 for http, :443 for https)", () => {
    expect(canonicalizeUrl("http://example.com:80/path")).toBe("http://example.com/path");
    expect(canonicalizeUrl("https://example.com:443/path")).toBe("https://example.com/path");
  });

  test("preserves non-default ports", () => {
    expect(canonicalizeUrl("http://example.com:8080/path")).toBe("http://example.com:8080/path");
    expect(canonicalizeUrl("https://example.com:8443/path")).toBe("https://example.com:8443/path");
  });

  test("removes trailing slashes on path except root /", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(canonicalizeUrl("https://example.com")).toBe("https://example.com/");
    expect(canonicalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
    expect(canonicalizeUrl("https://example.com/a/b/c/")).toBe("https://example.com/a/b/c");
  });

  test("removes tracking query parameters (utm_*, ref, gclid, fbclid, etc.)", () => {
    const raw =
      "https://example.com/story?utm_source=newsletter&utm_medium=email&utm_campaign=spring&ref=homepage&ref_src=tw&gclid=123&fbclid=456&msclkid=789&mc_cid=abc&mc_eid=def";
    expect(canonicalizeUrl(raw)).toBe("https://example.com/story");
  });

  test("preserves non-tracking query parameters and sorts them deterministically", () => {
    const raw =
      "https://example.com/items?z_param=last&utm_source=twitter&a_param=first&id=42";
    expect(canonicalizeUrl(raw)).toBe(
      "https://example.com/items?a_param=first&id=42&z_param=last",
    );
  });

  test("removes trailing slash when legitimate query parameters exist", () => {
    expect(canonicalizeUrl("https://example.com/items/?id=42")).toBe(
      "https://example.com/items?id=42",
    );
  });

  test("throws for invalid URL strings", () => {
    expect(() => canonicalizeUrl("not-a-valid-url")).toThrow();
  });
});

describe("deduplicateHits", () => {
  test("deduplicates hits with the same canonical URL and preserves first occurrence", () => {
    const hits: SearchHit[] = [
      {
        url: "https://example.com/article?utm_source=twitter",
        title: "Article 1",
        snippet: "First snippet",
        publishedAt: "2026-01-01",
      },
      {
        url: "https://example.org/other",
        title: "Other",
        snippet: "Other snippet",
      },
      {
        url: "https://example.com/article/",
        title: "Article 1 Duplicate",
        snippet: "Duplicate snippet",
      },
      {
        url: "https://example.com/article#section",
        title: "Article 1 Hash Variant",
        snippet: "Hash snippet",
      },
    ];

    const result = deduplicateHits(hits);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      url: "https://example.com/article",
      title: "Article 1",
      snippet: "First snippet",
      publishedAt: "2026-01-01",
    });
    expect(result[1]).toEqual({
      url: "https://example.org/other",
      title: "Other",
      snippet: "Other snippet",
    });
  });

  test("handles empty array", () => {
    expect(deduplicateHits([])).toEqual([]);
  });

  test("gracefully keeps hits with invalid URLs without crashing", () => {
    const hits: SearchHit[] = [
      { url: "bad-url-1", title: "Bad 1", snippet: "s1" },
      { url: "bad-url-1", title: "Bad 1 dup", snippet: "s2" },
      { url: "https://example.com/ok", title: "OK", snippet: "s3" },
    ];
    const result = deduplicateHits(hits);
    expect(result).toHaveLength(2);
    expect(result[0]?.url).toBe("bad-url-1");
    expect(result[1]?.url).toBe("https://example.com/ok");
  });
});
