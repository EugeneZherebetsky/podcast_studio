// Canned data behind the fake search provider and the fake extractor. The two sets fit
// together: every hit has a page, except the last one, whose extraction fails.
import type { ExtractedPage } from "./extract/interface.ts";
import type { SearchHit } from "./search/interface.ts";

function paragraphs(subject: string, facts: readonly string[]): string {
  return facts
    .map((fact, i) => `${subject}, paragraph ${i + 1}. ${fact} This sentence pads the paragraph.`)
    .join("\n\n");
}

export const FAKE_SEARCH_HITS: readonly SearchHit[] = [
  {
    url: "https://news.example.com/2026/bees-return",
    title: "City beekeepers report record hives",
    snippet: "Urban hive counts rose for the third year in a row.",
    publishedAt: "2026-10-02",
  },
  {
    url: "https://science.example.org/articles/pollinator-study",
    title: "Study maps pollinator routes with tiny radio tags",
    snippet: "Researchers tracked 400 bees across one summer.",
    publishedAt: "2026-09-18T08:30:00Z",
  },
  {
    url: "https://blog.example.net/garden/planting-for-bees",
    title: "What to plant for bees in autumn",
    snippet: "Late-flowering plants keep colonies fed before winter.",
  },
  {
    url: "https://encyclopedia.example.org/wiki/Honey_bee",
    title: "Honey bee",
    snippet: "Honey bees are social insects known for building wax nests.",
  },
  {
    url: "https://paywall.example.com/premium/bee-economy",
    title: "The economics of honey (subscribers only)",
    snippet: "Subscribe to read the full analysis.",
    publishedAt: "2026-08-30",
  },
];

export const FAKE_PAGES: Readonly<Record<string, ExtractedPage | null>> = {
  "https://news.example.com/2026/bees-return": {
    title: "City beekeepers report record hives",
    site: "news.example.com",
    publishedAt: "2026-10-02",
    text: paragraphs("Urban hives", [
      "The city registered 1,240 hives this year, up from 980 last year.",
      "Rooftop sites account for roughly a third of all registrations.",
      "The beekeepers' association credits new flower strips along tram lines.",
    ]),
  },
  "https://science.example.org/articles/pollinator-study": {
    title: "Study maps pollinator routes with tiny radio tags",
    site: "science.example.org",
    publishedAt: "2026-09-18T08:30:00Z",
    text: paragraphs("Pollinator routes", [
      "Researchers fitted 400 bees with radio tags weighing 4 milligrams each.",
      "Most foraging trips stayed within 800 metres of the hive.",
      "A few individuals flew more than 3 kilometres to reach a single lime tree.",
    ]),
  },
  "https://blog.example.net/garden/planting-for-bees": {
    title: "What to plant for bees in autumn",
    site: "blog.example.net",
    text: paragraphs("Autumn planting", [
      "Ivy flowers from September and is a major late nectar source.",
      "Asters and sedum bloom until the first frost.",
      "Leaving some stems uncut gives solitary bees a place to overwinter.",
    ]),
  },
  "https://encyclopedia.example.org/wiki/Honey_bee": {
    title: "Honey bee",
    site: "encyclopedia.example.org",
    text: paragraphs("Honey bees", [
      "A colony has one queen, many workers and, in summer, some drones.",
      "Workers communicate the direction of food with a waggle dance.",
      "A colony survives winter by clustering around its honey stores.",
    ]),
  },
  "https://paywall.example.com/premium/bee-economy": null,
};
