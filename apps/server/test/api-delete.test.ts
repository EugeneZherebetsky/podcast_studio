import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { episodes } from "../src/db/schema.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("deletes only a package within the configured episode directory", async () => {
  const root = makeTempDir();
  const dir = path.join(root, "episodes", "ep");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "audio.m4a"), "audio");
  const db = openDatabase(":memory:");
  const app = buildApp({ db, config: parseConfig({ DATA_DIR: root }) });
  try {
    db.insert(episodes)
      .values({
        id: "ep",
        topicId: null,
        title: "Title",
        summary: "",
        mode: "standard",
        lang: "en",
        durationMs: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        path: dir,
      })
      .run();
    expect((await app.inject({ method: "DELETE", url: "/api/episodes/ep" })).json()).toEqual({
      ok: true,
    });
    expect(existsSync(dir)).toBe(false);
    expect(db.select().from(episodes).all()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: "/api/episodes/ep" })).statusCode).toBe(404);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep"), "important");
    db.insert(episodes)
      .values({
        id: "bad",
        topicId: null,
        title: "Title",
        summary: "",
        mode: "standard",
        lang: "en",
        durationMs: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        path: outside,
      })
      .run();
    expect((await app.inject({ method: "DELETE", url: "/api/episodes/bad" })).statusCode).toBe(500);
    expect(existsSync(path.join(outside, "keep"))).toBe(true);
    expect(db.select().from(episodes).all()).toHaveLength(1);
  } finally {
    await app.close();
    db.$client.close();
    removeTempDir(root);
  }
});
