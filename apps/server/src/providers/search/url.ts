import type { SearchHit } from "./interface.ts";

const TRACKING_PARAM_NAMES = new Set([
  "ref",
  "ref_src",
  "ref_url",
  "gclid",
  "gclsrc",
  "dclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "zanpid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
  "trk",
  "si",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower);
}

/**
 * Normalises an arbitrary date string or Date instance to an ISO 8601 string.
 * Returns `undefined` if parsing fails or input is blank.
 */
export function formatPublishedDate(rawDate: unknown): string | undefined {
  if (typeof rawDate !== "string" && !(rawDate instanceof Date)) return undefined;
  if (typeof rawDate === "string" && rawDate.trim() === "") return undefined;
  try {
    const d = new Date(rawDate);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch {
    // Ignore invalid date strings
  }
  return undefined;
}

/**
 * Canonicalises a URL by:
 * - normalising protocol and hostname to lowercase
 * - removing default ports (80 for http, 443 for https)
 * - stripping hash/fragment
 * - stripping tracking parameters (utm_*, ref, gclid, fbclid, etc.)
 * - sorting remaining search parameters deterministically
 * - stripping trailing slashes from the pathname (except root "/")
 */
export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());

  // Protocol and host lowercase
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  // Strip default ports
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  // Strip hash/fragment
  url.hash = "";

  // Strip tracking parameters
  const keysToDelete: string[] = [];
  for (const [key] of url.searchParams) {
    if (isTrackingParam(key)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    url.searchParams.delete(key);
  }

  // Sort query parameters for deterministic canonical output
  url.searchParams.sort();

  // Strip trailing slashes on pathname except root "/"
  if (url.pathname !== "/") {
    const stripped = url.pathname.replace(/\/+$/, "");
    url.pathname = stripped === "" ? "/" : stripped;
  }

  return url.toString();
}

/**
 * Deduplicates search hits by canonical URL, preserving the order of first occurrence.
 * Each retained hit's `url` property is replaced with the canonicalised URL.
 */
export function deduplicateHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const deduped: SearchHit[] = [];

  for (const hit of hits) {
    let canonical = hit.url;
    try {
      canonical = canonicalizeUrl(hit.url);
    } catch {
      // Gracefully handle invalid URL strings: keep raw URL for deduplication
    }

    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    deduped.push({
      ...hit,
      url: canonical,
    });
  }

  return deduped;
}
