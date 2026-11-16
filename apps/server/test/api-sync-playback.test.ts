import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { devices, episodes, playback } from "../src/db/schema.ts";

test("playback upload is absent and existing progress is preserved", async () => {
  const db = openDatabase(":memory:");
  db.insert(devices).values({ id: "old", name: "phone", tokenHash: "old-hash", createdAt: "2026-01-01T00:00:00Z" }).run();
  db.insert(episodes).values({ id: "ep-1", title: "Example", summary: "", mode: "standard", lang: "en", durationMs: 10000, createdAt: "2026-01-01T00:00:00Z", path: "example" }).run();
  const position = { episodeId: "ep-1", deviceId: "old", positionMs: 4000, finished: false, updatedAt: "2026-01-02T00:00:00Z" };
  db.insert(playback).values(position).run();
  const app = buildApp({ db });
  try {
    expect((await app.inject({ method: "POST", url: "/api/sync/playback", payload: { positions: [{ ...position, positionMs: 9000 }] } })).statusCode).toBe(404);
    expect(db.select().from(playback).all()).toMatchObject([position]);
  } finally { await app.close(); db.$client.close(); }
});
