import { expect, test } from "vitest";
import { FakeExtractor } from "../src/providers/extract/fake.ts";
import { FAKE_PAGES, FAKE_SEARCH_HITS } from "../src/providers/fixtures.ts";
import { FakeSearchProvider } from "../src/providers/search/fake.ts";

test("fake search returns the canned hits, capped at max, and records calls", async () => {
  const search = new FakeSearchProvider();
  const all = await search.search("bees", { max: 50 });
  const two = await search.search("bees", { max: 2, freshnessDays: 7 });

  expect(all).toEqual(FAKE_SEARCH_HITS);
  expect(all.length).toBeGreaterThanOrEqual(3);
  expect(two).toEqual(FAKE_SEARCH_HITS.slice(0, 2));
  expect(search.calls).toEqual([
    { query: "bees", options: { max: 50 } },
    { query: "bees", options: { max: 2, freshnessDays: 7 } },
  ]);
});

test("fake search is deterministic and hands out copies", async () => {
  const search = new FakeSearchProvider();
  const first = await search.search("q", { max: 3 });
  first[0]!.title = "mutated";
  first.pop();
  expect(await search.search("q", { max: 3 })).toEqual(FAKE_SEARCH_HITS.slice(0, 3));
});

test("fake search can return different hits per query", async () => {
  const hit = { url: "https://example.org/x", title: "X", snippet: "about x" };
  const search = new FakeSearchProvider({ byQuery: { "only x": [hit], nothing: [] } });
  expect(await search.search("only x", { max: 5 })).toEqual([hit]);
  expect(await search.search("nothing", { max: 5 })).toEqual([]);
  expect(await search.search("anything else", { max: 5 })).toEqual(FAKE_SEARCH_HITS);
});

test("fake extractor returns the canned page for a known URL and null otherwise", async () => {
  const extractor = new FakeExtractor();
  const url = FAKE_SEARCH_HITS[0]!.url;
  const page = await extractor.extract(url);

  expect(page).toEqual(FAKE_PAGES[url]);
  expect(page?.text.length).toBeGreaterThan(100);
  expect(await extractor.extract("https://unknown.example/none")).toBeNull();
  expect(extractor.calls).toEqual([url, "https://unknown.example/none"]);
});

test("every canned search hit has a canned page, except the one marked as failing", async () => {
  const extractor = new FakeExtractor();
  const pages = await Promise.all(FAKE_SEARCH_HITS.map((hit) => extractor.extract(hit.url)));
  expect(pages.filter((page) => page !== null).length).toBeGreaterThanOrEqual(3);
  expect(pages.filter((page) => page === null)).toHaveLength(1);
});

test("fake extractor accepts its own pages, including explicit failures", async () => {
  const page = { title: "T", text: "body", site: "example.org" };
  const extractor = new FakeExtractor({
    pages: { "https://example.org/a": page, "https://example.org/broken": null },
  });
  expect(await extractor.extract("https://example.org/a")).toEqual(page);
  expect(await extractor.extract("https://example.org/broken")).toBeNull();
});
