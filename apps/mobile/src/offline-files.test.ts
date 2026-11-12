import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { sampleEpisode } from "./sample";

vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(parent: Directory | string, name?: string) { this.uri = name ? join(typeof parent === "string" ? parent : parent.uri, name) : String(parent); }
    get name() { return basename(this.uri); }
    get exists() { return existsSync(this.uri); }
    create(options?: { idempotent?: boolean; intermediates?: boolean }) { mkdirSync(this.uri, { recursive: !!options?.idempotent || !!options?.intermediates }); }
    delete() { rmSync(this.uri, { recursive: true }); }
    list() { return readdirSync(this.uri).map((name) => new Directory(this, name)); }
    async move(to: Directory) { if (to.exists) throw new Error("exists"); renameSync(this.uri, to.uri); }
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
import { listOfflineEpisodes, storeOfflineEpisode } from "./offline-files";

afterEach(() => { rmSync(join(String(Paths.document), "offline-episodes-v1"), { recursive: true, force: true }); });

describe("offline filesystem adapter", () => {
  const audio = Buffer.from("fixture audio");
  const episode = { ...sampleEpisode, audio: { ...sampleEpisode.audio, bytes: audio.length, sha256: createHash("sha256").update(audio).digest("hex") } };
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
