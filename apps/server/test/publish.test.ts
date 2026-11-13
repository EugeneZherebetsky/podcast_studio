import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EpisodeSchema, type Episode } from "shared";
import { openDatabase, type Db } from "../src/db/index.ts";
import { episodes } from "../src/db/schema.ts";
import { publishEpisode, type PublishStep } from "../src/pipeline/publish.ts";
import { generateJob } from "../src/pipeline/runner.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

const ID = "episode-1";
let dir: string;
let db: Db;
let root: string;
let finalDir: string;
let audioPath: string;

beforeEach(() => {
  dir = makeTempDir();
  db = openDatabase(":memory:");
  root = path.join(dir, "episodes");
  finalDir = path.join(root, ID);
  audioPath = path.join(dir, "work-audio.m4a");
  writeFileSync(audioPath, "first audio");
});
afterEach(() => {
  db.$client.close();
  removeTempDir(dir);
});

const metadata = (title = "Bees"): Omit<Episode, "audio"> => ({
  schemaVersion: 1,
  id: ID,
  title,
  summary: "About bees",
  createdAt: "2026-01-01T00:00:00.000Z",
  durationMs: 1000,
  mode: "standard",
  lang: "en",
  nativeLang: "en",
  segments: [],
  chapters: [],
  sources: [],
  generation: { profile: "local", llm: "fake", tts: "fake", voice: "fake", costUsd: 0 },
});
const publish = (crashAfter?: PublishStep, title?: string) =>
  publishEpisode({
    db,
    dataDir: dir,
    audioPath,
    episode: metadata(title),
    afterStep: (step) => {
      if (step === crashAfter) throw new Error(`crash after ${step}`);
    },
  });
const rows = () => db.select().from(episodes).all();
const leftovers = () => readdirSync(root).filter((name) => name !== ID);
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The package on disk is whole: valid metadata that describes exactly the audio beside it. */
function expectCompletePackage(title = "Bees"): Episode {
  const episode = EpisodeSchema.parse(
    JSON.parse(readFileSync(path.join(finalDir, "episode.json"), "utf8")),
  );
  const audio = path.join(finalDir, "audio.m4a");
  expect(episode).toMatchObject({ id: ID, title });
  expect(episode.audio).toEqual({
    file: "audio.m4a",
    bytes: readFileSync(audio).length,
    sha256: sha256(audio),
  });
  return episode;
}

test("publishes a complete package and only then the database row", async () => {
  const seen: Array<[PublishStep, boolean, number]> = [];
  const result = await publishEpisode({
    db,
    dataDir: dir,
    audioPath,
    episode: metadata(),
    afterStep: (step) => {
      seen.push([step, existsSync(finalDir), rows().length]);
    },
  });
  expect(seen).toEqual([
    ["staged", false, 0],
    ["renamed", true, 0],
    ["recorded", true, 1],
  ]);
  expect(result).toEqual({ dir: finalDir, reused: false });
  expectCompletePackage();
  expect(rows()).toMatchObject([{ id: ID, title: "Bees", durationMs: 1000, path: finalDir }]);
  expect(leftovers()).toEqual([]);
});

test("a crash after staging shows nothing, and the next run removes the leftover", async () => {
  await expect(publish("staged")).rejects.toThrow("crash after staged");
  expect(rows()).toEqual([]);
  expect(existsSync(finalDir)).toBe(false);
  expect(leftovers()).toHaveLength(1); // the staging directory, as a real crash would leave it

  await expect(publish()).resolves.toMatchObject({ reused: false });
  expectCompletePackage();
  expect(rows()).toHaveLength(1);
  expect(leftovers()).toEqual([]);
});

test("a crash after the rename leaves a whole but unlisted package that is replaced", async () => {
  await expect(publish("renamed")).rejects.toThrow("crash after renamed");
  expect(rows()).toEqual([]);
  expectCompletePackage();

  writeFileSync(audioPath, "second audio, re-assembled by the resumed job");
  await expect(publish(undefined, "Bees again")).resolves.toMatchObject({ reused: false });
  const episode = expectCompletePackage("Bees again");
  expect(episode.audio.sha256).toBe(sha256(audioPath));
  expect(rows()).toMatchObject([{ id: ID, title: "Bees again" }]);
  expect(leftovers()).toEqual([]);
});

test("a crash after the row is written keeps the published episode on the next run", async () => {
  await expect(publish("recorded")).rejects.toThrow("crash after recorded");
  const published = expectCompletePackage();
  expect(rows()).toHaveLength(1);

  // The resumed job re-assembles its audio; listeners may already have the published one.
  writeFileSync(audioPath, "second audio");
  await expect(publish(undefined, "Bees again")).resolves.toEqual({ dir: finalDir, reused: true });
  expect(expectCompletePackage()).toEqual(published);
  expect(rows()).toMatchObject([{ id: ID, title: "Bees" }]);
  expect(leftovers()).toEqual([]);
});

test("a failure while staging shows nothing and leaves nothing behind", async () => {
  audioPath = path.join(dir, "missing.m4a");
  await expect(publish()).rejects.toThrow(/missing\.m4a|ENOENT/);
  expect(rows()).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

test("invalid metadata is rejected before anything becomes visible", async () => {
  await expect(
    publishEpisode({ db, dataDir: dir, audioPath, episode: { ...metadata(), title: "" } }),
  ).rejects.toThrow();
  expect(rows()).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

test("a listed episode whose package is damaged is replaced by a complete one", async () => {
  await publish();
  writeFileSync(path.join(finalDir, "audio.m4a"), "truncat");
  writeFileSync(audioPath, "second audio");
  await expect(publish(undefined, "Bees again")).resolves.toMatchObject({ reused: false });
  expectCompletePackage("Bees again");
  expect(rows()).toMatchObject([{ id: ID, title: "Bees again" }]);
  expect(leftovers()).toEqual([]);
});

test("stale staging and set-aside directories of earlier crashes are removed", async () => {
  for (const name of [`.${ID}.aaaa.tmp`, `.${ID}.bbbb.old`, ".other-episode.cccc.tmp"]) {
    mkdirSync(path.join(root, name), { recursive: true });
    writeFileSync(path.join(root, name, "audio.m4a"), "half");
  }
  await publish();
  expectCompletePackage();
  expect(leftovers()).toEqual([".other-episode.cccc.tmp"]); // another job's: not ours to touch
});

test("an unlisted leftover that is still open is never half replaced", async () => {
  await expect(publish("renamed")).rejects.toThrow("crash after renamed");
  writeFileSync(audioPath, "second audio");
  // On Windows an open file can stop its directory from being moved; elsewhere it cannot.
  const handle = await open(path.join(finalDir, "audio.m4a"), "r");
  let failure: unknown;
  try {
    await publish(undefined, "Bees again");
  } catch (error) {
    failure = error;
  } finally {
    await handle.close();
  }
  if (failure) {
    expect(String(failure)).toMatch(/in use/i);
    expect(rows()).toEqual([]); // nothing was listed
    expectCompletePackage(); // and the leftover is still whole
    await publish(undefined, "Bees again");
  }
  const episode = expectCompletePackage("Bees again");
  expect(episode.audio.sha256).toBe(sha256(audioPath));
  expect(rows()).toMatchObject([{ id: ID, title: "Bees again" }]);
  expect(leftovers()).toEqual([]);
});

test("refuses an id that could leave the episodes directory", async () => {
  await expect(
    publishEpisode({ db, dataDir: dir, audioPath, episode: { ...metadata(), id: "../escape" } }),
  ).rejects.toThrow(/episode id/i);
  expect(existsSync(path.join(dir, "escape"))).toBe(false);
});

test(
  "a job that dies while publishing lists no episode and finishes when resumed",
  async () => {
    const run = fakeGeneration();
    try {
      const dying = generateJob(run.deps, run.jobId, {
        afterPublishStep: (step) => {
          if (step === "staged") throw new Error("crash after staged");
        },
      });
      await expect(dying).rejects.toThrow("crash after staged");
      expect(run.job()).toMatchObject({ status: "failed", currentStage: "publish" });
      expect(run.db.select().from(episodes).all()).toEqual([]);
      expect(existsSync(path.join(run.dir, "episodes", run.jobId))).toBe(false);

      await generateJob(run.deps, run.jobId);
      expect(run.job().status).toBe("succeeded");
      const row = run.db.select().from(episodes).get()!;
      const episode = EpisodeSchema.parse(
        JSON.parse(readFileSync(path.join(row.path, "episode.json"), "utf8")),
      );
      expect(episode.audio.sha256).toBe(sha256(path.join(row.path, "audio.m4a")));
      expect(readdirSync(path.join(run.dir, "episodes"))).toEqual([run.jobId]);
    } finally {
      run.close();
    }
  },
  GENERATION_TIMEOUT_MS,
);
