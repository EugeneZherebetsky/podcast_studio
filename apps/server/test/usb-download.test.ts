import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { expect, test } from "vitest";
import { openDatabase } from "../src/db/index.ts";
import { episodes } from "../src/db/schema.ts";
import { registerEpisodeRoutes } from "../src/episode-routes.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("USB downloads return the exact verified package without accepting paths", async () => {
  const root = makeTempDir();
  const db = openDatabase(":memory:");
  const app = Fastify();
  let replaceBeforeSend = false;
  app.addHook("onSend", async (_request, _reply, payload) => {
    if (replaceBeforeSend) {
      replaceBeforeSend = false;
      await rename(path.join(dir, "audio.m4a"), path.join(dir, "original.m4a"));
      await writeFile(path.join(dir, "audio.m4a"), "replacement");
    }
    return payload;
  });
  registerEpisodeRoutes(app, db, root);
  const id = "librivox-the-mouth";
  const dir = path.join(root, "episodes", id);
  try {
    await mkdir(dir, { recursive: true });
    for (const name of ["episode.json", "audio.m4a"]) await copyFile(new URL(`../../mobile/assets/${name}`, import.meta.url), path.join(dir, name));
    db.insert(episodes).values({ id, topicId: null, title: "The Mouth", summary: "", mode: "standard", lang: "en", durationMs: 1000, createdAt: "2026-01-01T00:00:00.000Z", path: dir }).run();
    for (const name of ["episode.json", "audio.m4a"]) {
      const response = await app.inject({ url: `/api/episodes/${id}/usb/${name}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toBe(`attachment; filename="${name}"`);
      if (name === "episode.json") expect(response.json()).toEqual(JSON.parse(await readFile(path.join(dir, name), "utf8")));
      else expect(response.rawPayload).toEqual(await readFile(path.join(dir, name)));
    }
    const metadataPath = path.join(dir, "episode.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.privateTopLevel = "do not export";
    metadata.audio.privateNested = "do not export";
    await writeFile(metadataPath, JSON.stringify(metadata));
    const redacted = await app.inject({ url: `/api/episodes/${id}/usb/episode.json` });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.json()).not.toHaveProperty("privateTopLevel");
    expect(redacted.json().audio).not.toHaveProperty("privateNested");
    expect((await app.inject({ url: `/api/episodes/${id}/usb/other` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/episodes/${id}/usb/audio.m4a`, remoteAddress: "192.0.2.1" })).statusCode).toBe(403);
    db.update(episodes).set({ path: root }).run();
    expect((await app.inject({ url: `/api/episodes/${id}/usb/audio.m4a` })).statusCode).toBe(422);
    db.update(episodes).set({ path: dir }).run();
    const verifiedAudio = await readFile(path.join(dir, "audio.m4a"));
    replaceBeforeSend = true;
    const raced = await app.inject({ url: `/api/episodes/${id}/usb/audio.m4a` });
    expect(raced.statusCode === 422 || raced.rawPayload.equals(verifiedAudio)).toBe(true);
    await writeFile(path.join(dir, "audio.m4a"), "corrupt");
    expect((await app.inject({ url: `/api/episodes/${id}/usb/episode.json` })).statusCode).toBe(422);
  } finally {
    await app.close();
    db.$client.close();
    removeTempDir(root);
  }
}, 30000);
