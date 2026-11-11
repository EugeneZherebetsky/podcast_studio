import { lookup as defaultLookup } from "node:dns/promises";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { ExtractedPage, Extractor } from "./interface.ts";
import { type DnsLookupFn, validateUrlForSsrf } from "./ssrf.ts";

export const DEFAULT_USER_AGENT = "PodcastStudio/1.0 (article reader)";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_ARTICLE_TEXT_LENGTH = 8000;

export interface ReadabilityExtractorOptions {
  fetch?: typeof fetch;
  lookup?: DnsLookupFn;
  userAgent?: string;
  timeoutMs?: number;
  maxSizeBytes?: number;
}

/**
 * Trims text exceeding `maxChars` at the last paragraph boundary (\n\n or \n)
 * under `maxChars`.
 */
export function trimToParagraphBoundary(text: string, maxChars = MAX_ARTICLE_TEXT_LENGTH): string {
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const doubleNewline = slice.lastIndexOf("\n\n");
  if (doubleNewline > 0) {
    const candidate = slice.slice(0, doubleNewline).trim();
    if (candidate) return candidate;
  }
  const singleNewline = slice.lastIndexOf("\n");
  if (singleNewline > 0) {
    const candidate = slice.slice(0, singleNewline).trim();
    if (candidate) return candidate;
  }
  const space = slice.lastIndexOf(" ");
  if (space > 0) {
    const candidate = slice.slice(0, space).trim();
    if (candidate) return candidate;
  }
  return slice.trim();
}

function normalizeIsoDate(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function findDateInJsonLd(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findDateInJsonLd(item);
      if (found) return found;
    }
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.datePublished === "string") {
    return obj.datePublished;
  }
  if (obj["@graph"] && Array.isArray(obj["@graph"])) {
    for (const item of obj["@graph"]) {
      const found = findDateInJsonLd(item);
      if (found) return found;
    }
  }
  return undefined;
}

function extractPublishedDate(
  doc: { querySelectorAll(s: string): Iterable<{ textContent?: string | null }>; querySelector(s: string): { getAttribute(attr: string): string | null } | null },
  articlePublishedTime?: string | null,
): string | undefined {
  // 1. JSON-LD datePublished
  try {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      const content = script.textContent;
      if (!content) continue;
      try {
        const parsed = JSON.parse(content);
        const iso = normalizeIsoDate(findDateInJsonLd(parsed));
        if (iso) return iso;
      } catch {
        // ignore invalid JSON
      }
    }
  } catch {
    // ignore query errors
  }

  // 2. Meta tags
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[property="og:published_time"]',
    'meta[name="publication_date"]',
    'meta[name="date"]',
    'meta[name="dc.date"]',
    'meta[name="DC.date.issued"]',
    'meta[name="parsely-pub-date"]',
    'meta[name="sailthru.date"]',
  ];

  for (const selector of metaSelectors) {
    const el = doc.querySelector(selector);
    const content = el?.getAttribute("content");
    const iso = normalizeIsoDate(content);
    if (iso) return iso;
  }

  // 3. <time datetime="...">
  const timeEl = doc.querySelector("time[datetime]");
  const timeContent = timeEl?.getAttribute("datetime");
  const timeIso = normalizeIsoDate(timeContent);
  if (timeIso) return timeIso;

  // 4. Readability article.publishedTime
  return normalizeIsoDate(articlePublishedTime);
}

function nodeToText(node: unknown): string {
  const n = node as {
    nodeType?: number;
    nodeValue?: string | null;
    tagName?: string;
    childNodes?: Iterable<unknown>;
  };

  if (n.nodeType === 3) {
    return n.nodeValue || "";
  }
  if (n.nodeType !== 1) {
    return "";
  }

  const tag = (n.tagName || "").toLowerCase();
  if (tag === "br") {
    return "\n";
  }

  let text = "";
  if (n.childNodes) {
    for (const child of n.childNodes) {
      text += nodeToText(child);
    }
  }

  const isBlock = /^(p|h[1-6]|li|blockquote|pre|div|section|article|header|footer)$/.test(tag);
  if (isBlock) {
    const trimmed = text.trim();
    return trimmed ? `\n\n${trimmed}\n\n` : "";
  }

  return text;
}

export function extractArticleText(
  articleContentHtml: string | null | undefined,
  fallbackText: string,
): string {
  if (articleContentHtml) {
    try {
      const wrapped = `<!DOCTYPE html><html><body>${articleContentHtml}</body></html>`;
      const { document } = parseHTML(wrapped);
      const extracted = nodeToText(document.body).replace(/\n{3,}/g, "\n\n").trim();
      if (extracted) {
        return extracted;
      }
    } catch {
      // fallback
    }
  }
  return fallbackText.trim();
}

export class ReadabilityExtractor implements Extractor {
  private readonly fetchFn: typeof fetch;
  private readonly lookupFn: DnsLookupFn;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxSizeBytes: number;

  constructor(options: ReadabilityExtractorOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.lookupFn = options.lookup ?? defaultLookup;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  }

  async extract(url: string): Promise<ExtractedPage | null> {
    try {
      return await this.extractInternal(url);
    } catch {
      return null;
    }
  }

  private async extractInternal(initialUrl: string): Promise<ExtractedPage | null> {
    let currentUrlStr = initialUrl;
    let redirectCount = 0;
    const maxRedirects = 5;

    let res: Response | null = null;
    let finalParsedUrl: URL | null = null;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      while (redirectCount <= maxRedirects) {
        const validation = await validateUrlForSsrf(currentUrlStr, this.lookupFn);
        if (!validation.allowed || !validation.parsedUrl) {
          return null;
        }

        finalParsedUrl = validation.parsedUrl;

        const currentRes: Response = await this.fetchFn(validation.parsedUrl.href, {
          method: "GET",
          headers: {
            "User-Agent": this.userAgent,
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          },
          redirect: "manual",
          signal: controller.signal,
        });

        // Handle redirects manually to protect against SSRF targets
        if (
          currentRes.status === 301 ||
          currentRes.status === 302 ||
          currentRes.status === 303 ||
          currentRes.status === 307 ||
          currentRes.status === 308
        ) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            return null;
          }
          const location = currentRes.headers.get("location");
          if (!location) {
            return null;
          }
          try {
            currentUrlStr = new URL(location, validation.parsedUrl).href;
          } catch {
            return null;
          }
          continue;
        }

        res = currentRes;
        break;
      }

      if (!res || !finalParsedUrl) {
        return null;
      }

      // Check HTTP status: must be 2xx
      if (res.status < 200 || res.status >= 300) {
        return null;
      }

      // Content-Type check: must be HTML
      const contentType = res.headers.get("content-type");
      if (!contentType) {
        return null;
      }
      const mime = contentType.split(";")[0]?.trim().toLowerCase();
      if (mime !== "text/html" && mime !== "application/xhtml+xml") {
        return null;
      }

      // Content-Length size cap check
      const contentLength = res.headers.get("content-length");
      if (contentLength) {
        const parsedLength = parseInt(contentLength, 10);
        if (!Number.isNaN(parsedLength) && parsedLength > this.maxSizeBytes) {
          return null;
        }
      }

      // Stream response body and enforce size cap
      if (!res.body) {
        return null;
      }

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > this.maxSizeBytes) {
            controller.abort();
            await reader.cancel().catch(() => {});
            return null;
          }
          chunks.push(value);
        }
      }

      const html = Buffer.concat(chunks).toString("utf-8");
      if (!html.trim()) {
        return null;
      }

      // Parse HTML with linkedom
      let doc: ReturnType<typeof parseHTML>["document"];
      try {
        const parsed = parseHTML(html);
        doc = parsed.document;
      } catch {
        return null;
      }

      // Extract metadata before running Readability
      const ogSiteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
      const appName = doc.querySelector('meta[name="application-name"]')?.getAttribute("content");
      const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
      const docTitle = doc.title || doc.querySelector("title")?.textContent || "";

      // Run Readability
      let article: ReturnType<Readability["parse"]>;
      try {
        const reader = new Readability(doc);
        article = reader.parse();
      } catch {
        return null;
      }

      if (!article || !article.textContent || !article.textContent.trim()) {
        return null;
      }

      const rawText = extractArticleText(article.content, article.textContent);
      const text = trimToParagraphBoundary(rawText, MAX_ARTICLE_TEXT_LENGTH);
      if (!text) {
        return null;
      }

      const publishedAt = extractPublishedDate(doc, article.publishedTime);
      const title = (article.title || ogTitle || docTitle || "").trim();
      if (!title) {
        return null;
      }

      const site =
        ogSiteName?.trim() ||
        appName?.trim() ||
        article.siteName?.trim() ||
        finalParsedUrl.hostname;

      return {
        title,
        text,
        site,
        ...(publishedAt ? { publishedAt } : {}),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
