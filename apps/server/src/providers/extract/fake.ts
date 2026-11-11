import { FAKE_PAGES } from "../fixtures.ts";
import type { ExtractedPage, Extractor } from "./interface.ts";

export interface FakeExtractorOptions {
  /** Pages by exact URL; null means the extraction fails. Default: `FAKE_PAGES`. */
  pages?: Readonly<Record<string, ExtractedPage | null>>;
}

/** Returns the canned page for a URL, null for unknown URLs, and records every call. */
export class FakeExtractor implements Extractor {
  /** Requested URLs, in order. */
  readonly calls: string[] = [];
  private readonly pages: Readonly<Record<string, ExtractedPage | null>>;

  constructor(options: FakeExtractorOptions = {}) {
    this.pages = options.pages ?? FAKE_PAGES;
  }

  async extract(url: string): Promise<ExtractedPage | null> {
    this.calls.push(url);
    const page = Object.hasOwn(this.pages, url) ? this.pages[url] : null;
    return page ? { ...page } : null;
  }
}
