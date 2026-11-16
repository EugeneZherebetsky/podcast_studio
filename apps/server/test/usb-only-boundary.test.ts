import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { devices } from "../src/db/schema.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("server refuses a configured LAN listener before opening application data", () => {
  const dir = makeTempDir();
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10000,
      env: { ...process.env, PODCAST_STUDIO_HOME: dir, DATA_DIR: dir, HOST: "0.0.0.0", PROFILE: "local", SEARCH_PROVIDER: "searxng", TTS_PROVIDER: "piper" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("loopback");
    expect(readdirSync(dir)).toEqual([]);
  } finally { removeTempDir(dir); }
}, 15000);

test("phone transfer routes are absent and legacy tokens cannot access the desktop API remotely", async () => {
  const db = openDatabase(":memory:");
  const token = "a".repeat(43);
  db.insert(devices).values({ id: "old", name: "old", tokenHash: createHash("sha256").update(token).digest("hex"), createdAt: new Date().toISOString() }).run();
  const app = buildApp({ db });
  try {
    for (const url of ["/api/pair/start", "/api/pair/complete", "/api/sync/playback", "/api/sync/vocab"]) {
      expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url, remoteAddress: "192.0.2.1", headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: "/api/topics", remoteAddress: "192.0.2.1", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/topics" })).statusCode).toBe(200);
    expect(db.select().from(devices).all()).toHaveLength(1);
  } finally {
    await app.close();
    db.$client.close();
  }
});
