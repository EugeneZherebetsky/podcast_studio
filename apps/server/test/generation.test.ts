import path from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/index.ts";
import { episodes, jobs } from "../src/db/schema.ts";
import { createJob, generateJob, markJobInterrupted, startJob } from "../src/pipeline/runner.ts";
import { createFakeProviders } from "../src/providers/index.ts";
import type { FakeLlmCall } from "../src/providers/llm/fake.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";
import { fakeGeneration } from "./generation-fakes.ts";

function respond(call: FakeLlmCall): unknown {
  const id = /<source id="(s\d+)">/.exec(call.prompt)?.[1];
  if (id) return { facts: [`Fact from ${id}`] };
  if (call.prompt.includes("<facts>"))
    return { outline: [{ heading: "Facts", facts: [{ text: "A fact", sourceIds: ["s1"] }] }] };
  if (call.slot === "fast")
    return { queries: ["one", "two", "three", "four", "five"], angle: "Bees" };
  const kinds = ["intro", "content", "content", "content", "recap", "outro"];
  return {
    title: "Bees",
    summary: "About bees",
    chapters: [1, 2, 3].map((segmentIndex) => ({ title: `Chapter ${segmentIndex}`, segmentIndex })),
    segments: kinds.map((kind) => ({
      kind,
      speaker: "host",
      lang: "en",
      text: Array(23).fill("bees").join(" "),
      ...(kind === "content" ? { sourceIds: ["s1"] } : {}),
    })),
  };
}

test("a fresh job publishes playable audio", async () => {
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  try {
    const providers = createFakeProviders({ wavDir: path.join(dir, "wav") });
    providers.llm.enqueue(...Array.from({ length: 30 }, () => respond));
    const job = createJob(
      db,
      { title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false },
      20,
    );
    const deps = {
      db,
      providers,
      dataDir: dir,
      budgetUsd: 20,
      voice: "fake",
      profile: "local",
      llmName: "fake",
      ttsName: "fake",
      nativeLang: "en",
    };
    await generateJob(deps, job.id);
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.status).toBe("succeeded");
    const episode = db.select().from(episodes).get()!;
    expect(
      JSON.parse(readFileSync(path.join(episode.path, "episode.json"), "utf8")).segments,
    ).toHaveLength(6);
    expect(readFileSync(path.join(episode.path, "audio.m4a")).length).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, "wav"))).toBe(false);
    const runRoot = path.join(dir, "jobs", job.id, "runs");
    expect(readdirSync(path.join(runRoot, readdirSync(runRoot)[0]!, "tts")).length).toBeGreaterThan(0);
  } finally {
    db.$client.close();
    removeTempDir(dir);
  }
});

test("a stale executor cannot overwrite a newer owner's canonical artifacts", async () => {
  const f = fakeGeneration();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const llm = f.deps.providers.llm;
  f.deps.providers.llm = {
    async generateObject(request) {
      entered();
      await gate;
      return llm.generateObject(request);
    },
  };
  try {
    const oldRun = generateJob(f.deps, f.jobId);
    const result = oldRun.catch((error: Error) => error);
    await blocked;
    markJobInterrupted(f.db, f.jobId);
    startJob(f.db, f.jobId, 20);
    mkdirSync(f.workDir, { recursive: true });
    const canonical = path.join(f.workDir, "plan.json");
    writeFileSync(canonical, "new owner");
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(readFileSync(canonical, "utf8")).toBe("new owner");
    expect(existsSync(path.join(f.workDir, "plan.inputs.sha256"))).toBe(false);
    const oldDir = path.join(f.workDir, "runs", readdirSync(path.join(f.workDir, "runs"))[0]!);
    const newDir = path.join(f.workDir, "runs", "new-owner");
    mkdirSync(newDir);
    writeFileSync(path.join(newDir, "plan.json"), "new run");
    writeFileSync(path.join(oldDir, "plan.json"), "late child write");
    expect(readFileSync(path.join(newDir, "plan.json"), "utf8")).toBe("new run");
    expect(readFileSync(canonical, "utf8")).toBe("new owner");
  } finally {
    f.close();
  }
});

test("a stale TTS call writes only to its abandoned run", async () => {
  const f = fakeGeneration();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = f.deps.providers.tts;
  f.deps.providers.tts = {
    ...original,
    voices: original.voices.bind(original),
    synthesize: original.synthesize.bind(original),
    forRun(dir) {
      const isolated = original.forRun!(dir);
      return {
        voices: isolated.voices.bind(isolated),
        async synthesize(request) {
          entered();
          await gate;
          return isolated.synthesize(request);
        },
      };
    },
  };
  try {
    const result = generateJob(f.deps, f.jobId).catch((error: Error) => error);
    await blocked;
    markJobInterrupted(f.db, f.jobId);
    const owner = startJob(f.db, f.jobId, 20);
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(f.job().ownerToken).toBe(owner);
    expect(f.job().status).toBe("running");
    expect(existsSync(path.join(f.dir, "wav"))).toBe(false);
    expect(existsSync(path.join(f.dir, "cache", "tts"))).toBe(false);
    expect(f.db.select().from(episodes).all()).toHaveLength(0);
    expect(existsSync(path.join(f.dir, "episodes", f.jobId))).toBe(false);
  } finally {
    release();
    f.close();
  }
});

test("a new run ignores and preserves legacy canonical cache", async () => {
  const f = fakeGeneration();
  try {
    const { runPlanStage } = await import("../src/pipeline/plan.ts");
    await runPlanStage({ workDir: f.workDir, llm: f.deps.providers.llm }, f.job().options);
    const before = readFileSync(path.join(f.workDir, "plan.json"), "utf8");
    const hash = readFileSync(path.join(f.workDir, "plan.inputs.sha256"), "utf8");
    f.llm.stages.length = 0;
    await generateJob(f.deps, f.jobId);
    expect(f.llm.stages).toContain("plan");
    expect(readFileSync(path.join(f.workDir, "plan.json"), "utf8")).toBe(before);
    expect(readFileSync(path.join(f.workDir, "plan.inputs.sha256"), "utf8")).toBe(hash);
    const runDir = path.join(f.workDir, "runs", f.job().ownerToken!);
    expect(existsSync(path.join(runDir, "plan.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "notes.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "tts"))).toBe(true);
    expect(existsSync(path.join(f.workDir, "notes.json"))).toBe(false);
    expect(f.job().status).toBe("succeeded");
  } finally {
    f.close();
  }
});

test("failed stages leave canonical artifacts untouched and retain run artifacts", async () => {
  const f = fakeGeneration();
  try {
    mkdirSync(f.workDir, { recursive: true });
    writeFileSync(path.join(f.workDir, "plan.json"), "legacy plan");
    writeFileSync(path.join(f.workDir, "plan.inputs.sha256"), "legacy hash");
    f.llm.failIn = "notes";
    await expect(generateJob(f.deps, f.jobId)).rejects.toThrow(/model offline/);
    expect(readFileSync(path.join(f.workDir, "plan.json"), "utf8")).toBe("legacy plan");
    expect(readFileSync(path.join(f.workDir, "plan.inputs.sha256"), "utf8")).toBe("legacy hash");
    expect(existsSync(path.join(f.workDir, "sources.json"))).toBe(false);
    expect(existsSync(path.join(f.workDir, "runs", f.job().ownerToken!, "sources.json"))).toBe(true);
    expect(f.db.select().from(episodes).all()).toHaveLength(0);
  } finally {
    f.close();
  }
});
