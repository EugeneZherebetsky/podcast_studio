import { expect, test } from "vitest";
import { openDatabase } from "../src/db/index.ts";
import { topics, episodes, usedSources } from "../src/db/schema.ts";
import { recurringContext } from "../src/pipeline/recurring.ts";

test("loads only the latest five summaries and used URLs for the topic", () => {
  const db = openDatabase(":memory:");
  try {
    for (const id of ["a", "b"])
      db.insert(topics).values({ id, title: id, mode: "standard", lang: "en", minutes: 8 }).run();
    for (let i = 0; i < 7; i++)
      db.insert(episodes)
        .values({
          id: `e${i}`,
          topicId: "a",
          title: `Title ${i}`,
          summary: `Summary ${i}`,
          mode: "standard",
          lang: "en",
          durationMs: 1,
          createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
          path: "episode",
        })
        .run();
    db.insert(episodes)
      .values({
        id: "other",
        topicId: "b",
        title: "Other",
        summary: "Other",
        mode: "standard",
        lang: "en",
        durationMs: 1,
        createdAt: "2027-01-01T00:00:00.000Z",
        path: "episode",
      })
      .run();
    db.insert(usedSources)
      .values([
        { topicId: "a", episodeId: "e0", canonicalUrl: "https://example.com/a" },
        { topicId: "b", episodeId: "other", canonicalUrl: "https://example.com/b" },
      ])
      .run();
    expect(recurringContext(db, "a")).toEqual({
      previousEpisodes: [6, 5, 4, 3, 2].map((i) => ({
        title: `Title ${i}`,
        summary: `Summary ${i}`,
      })),
      usedUrls: ["https://example.com/a"],
    });
  } finally {
    db.$client.close();
  }
});
