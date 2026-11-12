import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import { artifactPaths, hashInputs, runCachedStage } from "../src/pipeline/artifacts.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let dir: string;

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

const Schema = z.object({ value: z.number() });

function stage(inputs: unknown, value: number, counter: { runs: number }, workDir = dir) {
  return runCachedStage({
    workDir,
    stage: "plan",
    inputs,
    schema: Schema,
    run: async () => {
      counter.runs++;
      return { artifact: { value }, usage: [] };
    },
  });
}

test("hashInputs is a sha256 that ignores key order and undefined values", () => {
  const a = hashInputs({ b: 1, a: [1, { y: 2, x: 1 }], c: undefined });
  const b = hashInputs({ a: [1, { x: 1, y: 2 }], b: 1 });
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).toBe(b);
  expect(hashInputs({ a: [1, { x: 1, y: 3 }], b: 1 })).not.toBe(a);
  expect(hashInputs([1, 2])).not.toBe(hashInputs([2, 1]));
});

test("a stage writes its artifact and the hash of its inputs next to it", async () => {
  const counter = { runs: 0 };
  const result = await stage({ topic: "bees" }, 1, counter);

  const paths = artifactPaths(dir, "plan");
  expect(paths.artifact).toBe(path.join(dir, "plan.json"));
  expect(JSON.parse(readFileSync(paths.artifact, "utf8"))).toEqual({ value: 1 });
  expect(readFileSync(paths.hash, "utf8").trim()).toBe(hashInputs({ topic: "bees" }));
  expect(result).toMatchObject({ artifact: { value: 1 }, skipped: false });
  expect(result.inputHash).toBe(hashInputs({ topic: "bees" }));
  expect(counter.runs).toBe(1);
});

test("the work directory is created when it does not exist", async () => {
  const workDir = path.join(dir, "jobs", "job-1");
  await stage({ topic: "bees" }, 1, { runs: 0 }, workDir);
  expect(existsSync(path.join(workDir, "plan.json"))).toBe(true);
});

test("unchanged inputs skip the stage and return the stored artifact", async () => {
  const counter = { runs: 0 };
  await stage({ topic: "bees" }, 1, counter);
  const second = await stage({ topic: "bees" }, 2, counter);

  expect(counter.runs).toBe(1);
  expect(second).toMatchObject({ artifact: { value: 1 }, skipped: true, usage: [] });
});

test("changed inputs re-run the stage and overwrite the artifact", async () => {
  const counter = { runs: 0 };
  await stage({ topic: "bees" }, 1, counter);
  const second = await stage({ topic: "wasps" }, 2, counter);

  expect(counter.runs).toBe(2);
  expect(second).toMatchObject({ artifact: { value: 2 }, skipped: false });
  expect(JSON.parse(readFileSync(artifactPaths(dir, "plan").artifact, "utf8"))).toEqual({
    value: 2,
  });
});

test("a missing, unreadable or schema-invalid artifact re-runs the stage", async () => {
  const counter = { runs: 0 };
  const paths = artifactPaths(dir, "plan");
  await stage({ topic: "bees" }, 1, counter);

  writeFileSync(paths.artifact, "{ not json");
  expect((await stage({ topic: "bees" }, 2, counter)).artifact).toEqual({ value: 2 });

  writeFileSync(paths.artifact, JSON.stringify({ value: "three" }));
  expect((await stage({ topic: "bees" }, 3, counter)).artifact).toEqual({ value: 3 });
  expect(counter.runs).toBe(3);
});

test("a failing stage writes nothing: the next run for those inputs executes again", async () => {
  const counter = { runs: 0 };
  await stage({ topic: "bees" }, 1, counter);
  await expect(
    runCachedStage({
      workDir: dir,
      stage: "plan",
      inputs: { topic: "wasps" },
      schema: Schema,
      run: async () => {
        throw new Error("boom");
      },
    }),
  ).rejects.toThrow("boom");

  // Nothing claims to match the new inputs, and the stored artifact still serves the old.
  expect(await stage({ topic: "bees" }, 4, counter)).toMatchObject({
    artifact: { value: 1 },
    skipped: true,
  });
  const retry = await stage({ topic: "wasps" }, 5, counter);
  expect(retry).toMatchObject({ artifact: { value: 5 }, skipped: false });
});

test("an artifact that does not match the schema is rejected instead of written", async () => {
  await expect(
    runCachedStage({
      workDir: dir,
      stage: "plan",
      inputs: {},
      schema: Schema,
      run: async () => ({ artifact: { value: "x" } as unknown as { value: number }, usage: [] }),
    }),
  ).rejects.toThrow(/plan/);
  expect(existsSync(artifactPaths(dir, "plan").artifact)).toBe(false);
});
