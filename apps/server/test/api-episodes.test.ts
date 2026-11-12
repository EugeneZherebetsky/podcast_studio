import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { episodes } from "../src/db/schema.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("episode listing and audio range requests use the stored package", async () => {
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  try {
    writeFileSync(path.join(dir, "audio.m4a"), "abcdefghij");
    db.insert(episodes)
      .values({
        id: "ep",
        topicId: null,
        title: "Title",
        summary: "",
        mode: "standard",
        lang: "en",
        durationMs: 1000,
        createdAt: "2026-01-01T00:00:00.000Z",
        path: dir,
      })
      .run();
    const list = await app.inject({ url: "/api/episodes" });
    expect(list.json().episodes[0]).not.toHaveProperty("path");
    const audio = await app.inject({
      url: "/api/episodes/ep/audio",
      headers: { range: "bytes=2-4" },
    });
    expect(audio.statusCode).toBe(206);
    expect(audio.headers["content-range"]).toBe("bytes 2-4/10");
    expect(audio.body).toBe("cde");
    expect(
      (await app.inject({ url: "/api/episodes/ep/audio", headers: { range: "bytes=99-" } }))
        .statusCode,
    ).toBe(416);
  } finally {
    await app.close();
    db.$client.close();
    removeTempDir(dir);
  }
});
