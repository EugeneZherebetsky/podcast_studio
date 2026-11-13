import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { sampleEpisode } from "./sample";
import { EventEmitter } from "node:events";
import { parseConfig } from "shared";
import { buildApp } from "../../server/src/app";
import { openDatabase } from "../../server/src/db/index";
import { episodes } from "../../server/src/db/schema";
import { offlinePlayback } from "./offline-playback";

const fault = vi.hoisted(() => ({ partialMove: false }));

vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(parent: Directory | string, name?: string) { this.uri = name ? join(typeof parent === "string" ? parent : parent.uri, name) : String(parent); }
    get name() { return basename(this.uri); }
    get exists() { return existsSync(this.uri); }
    create(options?: { idempotent?: boolean; intermediates?: boolean }) { mkdirSync(this.uri, { recursive: !!options?.idempotent || !!options?.intermediates }); }
    delete() { rmSync(this.uri, { recursive: true }); }
    list() { return readdirSync(this.uri).map((name) => new Directory(this, name)); }
    async move(to: Directory) {
      if (to.exists) throw new Error("exists");
      if (fault.partialMove) {
        mkdirSync(to.uri);
        writeFileSync(join(to.uri, "episode.json"), readFileSync(join(this.uri, "episode.json")));
        writeFileSync(join(to.uri, "audio.m4a"), readFileSync(join(this.uri, "audio.m4a")).subarray(0, 2));
        throw new Error("move interrupted");
      }
      renameSync(this.uri, to.uri);
    }
  }
  class File {
    uri: string;
    constructor(parent: Directory, name: string) { this.uri = join(parent.uri, name); }
    get exists() { return existsSync(this.uri); }
    get size() { return statSync(this.uri).size; }
    async digest() { return createHash("sha256").update(readFileSync(this.uri)).digest("hex"); }
    async write(value: string | Uint8Array) { writeFileSync(this.uri, value); }
    async json() { return JSON.parse(readFileSync(this.uri, "utf8")); }
  }
  return { Directory, File, Paths: { document: mkdtempSync(join(tmpdir(), "offline-test-")) } };
});

import { Paths } from "expo-file-system";
import { importUsbEpisode, listOfflineEpisodes, storeOfflineEpisode } from "./offline-files";

afterEach(() => { rmSync(join(String(Paths.document), "offline-episodes-v1"), { recursive: true, force: true }); });

describe("offline filesystem adapter", () => {
  it("imports desktop Library downloads and keeps local playback progress on duplicate", async () => {
    const root = mkdtempSync(join(tmpdir(), "usb-roundtrip-"));
    const db = openDatabase(":memory:");
    const app = buildApp({ db, config: parseConfig({ DATA_DIR: root }), events: new EventEmitter() });
    const dir = join(root, "episodes", sampleEpisode.id);
    mkdirSync(dir, { recursive: true });
    for (const name of ["episode.json", "audio.m4a"]) {
      writeFileSync(join(dir, name), readFileSync(new URL(`../assets/${name}`, import.meta.url)));
    }
    db.insert(episodes).values({ id: sampleEpisode.id, topicId: null, title: sampleEpisode.title, summary: "", mode: "standard", lang: "en", durationMs: sampleEpisode.durationMs, createdAt: sampleEpisode.createdAt, path: dir }).run();
    try {
      const metadata = await app.inject({ url: `/api/episodes/${sampleEpisode.id}/usb/episode.json` });
      const audio = await app.inject({ url: `/api/episodes/${sampleEpisode.id}/usb/audio.m4a` });
      expect(metadata.statusCode).toBe(200);
      expect(audio.statusCode).toBe(200);
      const copied = join(root, "phone-copy");
      mkdirSync(copied);
      writeFileSync(join(copied, "episode.json"), metadata.rawPayload);
      writeFileSync(join(copied, "audio.m4a"), audio.rawPayload);
      const selectedMetadata = { json: async () => JSON.parse(readFileSync(join(copied, "episode.json"), "utf8")) };
      const selectedAudio = { copy: async (destination: { write(data: Uint8Array): Promise<void> }) => destination.write(readFileSync(join(copied, "audio.m4a"))) };
      const storage = new Map<string, string>();
      const kv = { getItemSync: (key: string) => storage.get(key) ?? null, setItemSync: (key: string, value: string) => { storage.set(key, value); } };
      await importUsbEpisode(selectedMetadata, selectedAudio);
      const [saved] = await listOfflineEpisodes();
      expect(saved?.episode).toEqual(sampleEpisode);
      expect(readFileSync(saved!.audioUri)).toEqual(audio.rawPayload);
      offlinePlayback(kv, sampleEpisode.id).record(42, false);
      await expect(importUsbEpisode(selectedMetadata, selectedAudio)).rejects.toThrow("already exists");
      expect(offlinePlayback(kv, sampleEpisode.id).position()).toBe(42);
    } finally {
      await app.close();
      db.$client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
  const audio = Buffer.from("fixture audio");
  const episode = { ...sampleEpisode, audio: { ...sampleEpisode.audio, bytes: audio.length, sha256: createHash("sha256").update(audio).digest("hex") } };
  it("imports a selected package and refuses a duplicate without replacing it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const metadata = { json: async () => episode };
    const source = { copy: async (destination: { write(data: Uint8Array): Promise<void> }) => destination.write(audio) };
    await importUsbEpisode(metadata, source);
    await expect(importUsbEpisode(metadata, source)).rejects.toThrow("already exists");
    expect(await listOfflineEpisodes()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("rejects a duplicate even when the existing published audio is damaged", async () => {
    const source = { copy: async (destination: { write(data: Uint8Array): Promise<void> }) => destination.write(audio) };
    await importUsbEpisode({ json: async () => episode }, source);
    const [original] = await listOfflineEpisodes();
    writeFileSync(original!.audioUri, "damaged");
    await expect(importUsbEpisode({ json: async () => episode }, source)).rejects.toThrow("already exists");
    expect(readFileSync(original!.audioUri, "utf8")).toBe("damaged");
  });
  it("rejects invalid or interrupted packages without affecting the library", async () => {
    const source = { copy: async (destination: { write(data: Uint8Array): Promise<void> }) => destination.write(audio) };
    await importUsbEpisode({ json: async () => episode }, source);
    const second = { ...episode, id: "second" };
    await expect(importUsbEpisode({ json: async () => { throw new Error("invalid JSON"); } }, source)).rejects.toThrow("invalid JSON");
    await expect(importUsbEpisode({ json: async () => ({ ...second, audio: { ...second.audio, file: "../audio.m4a" } }) }, source)).rejects.toThrow();
    await expect(importUsbEpisode({ json: async () => ({ ...second, schemaVersion: 2 }) }, source)).rejects.toThrow();
    await expect(importUsbEpisode({ json: async () => second }, { copy: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    await expect(importUsbEpisode({ json: async () => second }, { copy: async () => {} })).rejects.toThrow("missing");
    await expect(importUsbEpisode({ json: async () => second }, { copy: async (destination) => destination.write("corrupt") })).rejects.toThrow("verification");
    expect((await listOfflineEpisodes()).map((row) => row.episode.id)).toEqual([episode.id]);
    expect(readdirSync(join(String(Paths.document), "offline-episodes-v1"))).toHaveLength(1);
  });
  it("ignores an interrupted partial publication while preserving the existing library", async () => {
    await storeOfflineEpisode(episode, async (file) => { await file.write(audio); });
    const partial = join(String(Paths.document), "offline-episodes-v1", "episode-interrupted");
    mkdirSync(partial);
    writeFileSync(join(partial, "episode.json"), JSON.stringify({ ...episode, id: "second" }));
    writeFileSync(join(partial, "audio.m4a"), audio.subarray(0, 2));
    expect((await listOfflineEpisodes()).map((row) => row.episode.id)).toEqual([episode.id]);
    expect(existsSync(partial)).toBe(true);
  });
  it("retries a partial legacy import without altering its files or progress", async () => {
    const partial = join(String(Paths.document), "offline-episodes-v1", "episode-interrupted");
    mkdirSync(partial, { recursive: true });
    const metadata = JSON.stringify(episode);
    const truncated = audio.subarray(0, 2);
    writeFileSync(join(partial, "episode.json"), metadata);
    writeFileSync(join(partial, "audio.m4a"), truncated);
    const storage = new Map<string, string>();
    const kv = { getItemSync: (key: string) => storage.get(key) ?? null, setItemSync: (key: string, value: string) => { storage.set(key, value); } };
    offlinePlayback(kv, episode.id).record(42, false);
    expect(await listOfflineEpisodes()).toEqual([]);
    await importUsbEpisode({ json: async () => episode }, { copy: async (file) => file.write(audio) });
    expect((await listOfflineEpisodes()).map((row) => row.episode.id)).toEqual([episode.id]);
    expect(readFileSync(join(partial, "episode.json"), "utf8")).toBe(metadata);
    expect(readFileSync(join(partial, "audio.m4a"))).toEqual(truncated);
    expect(offlinePlayback(kv, episode.id).position()).toBe(42);
  });
  it("refuses duplicates of intact legacy imports", async () => {
    const legacy = join(String(Paths.document), "offline-episodes-v1", "episode-intact");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "episode.json"), JSON.stringify(episode));
    writeFileSync(join(legacy, "audio.m4a"), audio);
    expect(await listOfflineEpisodes()).toHaveLength(1);
    await expect(importUsbEpisode({ json: async () => episode }, { copy: async (file) => file.write(audio) })).rejects.toThrow("already exists");
    expect(readFileSync(join(legacy, "audio.m4a"))).toEqual(audio);
  });
  it("does not expose a fully copied destination before its commit marker", async () => {
    const partial = join(String(Paths.document), "offline-episodes-v1", "published-interrupted");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "episode.json"), JSON.stringify(episode));
    writeFileSync(join(partial, "audio.m4a"), audio);
    expect(await listOfflineEpisodes()).toEqual([]);
    writeFileSync(join(partial, "commit.json"), '{"committed":');
    expect(await listOfflineEpisodes()).toEqual([]);
  });
  it("keeps partial copy/delete publication invisible and permits retry", async () => {
    await storeOfflineEpisode(episode, async (file) => { await file.write(audio); });
    const second = { ...episode, id: "second" };
    fault.partialMove = true;
    try {
      await expect(importUsbEpisode({ json: async () => second }, { copy: async (file) => file.write(audio) })).rejects.toThrow("move interrupted");
    } finally { fault.partialMove = false; }
    expect((await listOfflineEpisodes()).map((row) => row.episode.id)).toEqual([episode.id]);
    await importUsbEpisode({ json: async () => second }, { copy: async (file) => file.write(audio) });
    expect((await listOfflineEpisodes()).map((row) => row.episode.id).sort()).toEqual([episode.id, "second"].sort());
  });
  it("stores a verified package and reads it back", async () => {
    await storeOfflineEpisode(episode, async (file) => { await file.write(audio); });
    const rows = await listOfflineEpisodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.episode).toEqual(episode);
    expect(readFileSync(rows[0]!.audioUri)).toEqual(audio);
  });
  it("removes only staging on corruption or transfer failure", async () => {
    await expect(storeOfflineEpisode(episode, async (file) => { await file.write("bad"); })).rejects.toThrow("verification");
    await expect(storeOfflineEpisode(episode, async () => { throw new Error("transfer failed"); })).rejects.toThrow("transfer failed");
    expect(await listOfflineEpisodes()).toEqual([]);
    expect(readdirSync(join(String(Paths.document), "offline-episodes-v1"))).toEqual([]);
  });
});
