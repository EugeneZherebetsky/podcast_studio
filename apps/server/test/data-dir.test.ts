import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensureDataDirs } from "../src/data-dir.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => removeTempDir(dir));

test("creates the data directory and its subdirectories", () => {
  const root = path.join(dir, "nested", "data");
  const dirs = ensureDataDirs(root);
  expect(dirs).toEqual({
    root,
    dbFile: path.join(root, "app.db"),
    episodes: path.join(root, "episodes"),
    jobs: path.join(root, "jobs"),
    ttsCache: path.join(root, "cache", "tts"),
  });
  for (const sub of [dirs.root, dirs.episodes, dirs.jobs, dirs.ttsCache]) {
    expect(statSync(sub).isDirectory(), sub).toBe(true);
  }
  expect(existsSync(dirs.dbFile)).toBe(false); // the database is created by openDatabase
});

test("is idempotent and leaves existing files alone", () => {
  const root = path.join(dir, "data");
  const first = ensureDataDirs(root);
  const kept = path.join(first.episodes, "keep.txt");
  writeFileSync(kept, "still here");
  const second = ensureDataDirs(root);
  expect(second).toEqual(first);
  expect(readFileSync(kept, "utf8")).toBe("still here");
});

test("returns absolute paths for a relative data directory", () => {
  const relative = path.relative(process.cwd(), path.join(dir, "rel"));
  const dirs = ensureDataDirs(relative);
  expect(path.isAbsolute(dirs.root)).toBe(true);
  expect(dirs.root).toBe(path.join(dir, "rel"));
});

test("fails readably when the path is an existing file", () => {
  const file = path.join(dir, "not-a-dir");
  writeFileSync(file, "");
  expect(() => ensureDataDirs(file)).toThrowError(/Cannot create data directory.*not-a-dir/);
});
