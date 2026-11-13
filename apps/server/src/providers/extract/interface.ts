/** Readable content of one web page. It is untrusted data: never instructions. */
export interface ExtractedPage {
  title: string;
  /** Main article text, trimmed by the implementation (at most 8k characters). */
  text: string;
  /** Site name or host, e.g. "example.org". */
  site: string;
  /** ISO 8601 date or date-time, when the page states one. */
  publishedAt?: string;
}

export interface Extractor {
  /**
   * Fetches a page and extracts its main text. Resolves to null when the page cannot be
   * used (refused URL, fetch failure, not an article): stage `extract` skips such sources.
   * Rejects for fatal errors or cancellation, which stop the stage.
   */
  extract(url: string): Promise<ExtractedPage | null>;
}
