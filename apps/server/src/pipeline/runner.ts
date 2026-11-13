import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { JobOptionsSchema, STAGE_NAMES, type JobOptions, type StageName } from "shared";
import type { Db } from "../db/index.ts";
import { jobs, jobStages } from "../db/schema.ts";
import { usageOfFailedCall, type LlmProvider, type Usage } from "../providers/llm/interface.ts";
import { monthTotalCostUsd, recordLlmUsage } from "../usage.ts";
import type { StageResult } from "./artifacts.ts";

function checkBudget(db: Db, budgetUsd: number): void {
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error("Invalid budget");
  const total = monthTotalCostUsd(db);
  if (!Number.isFinite(total) || total < 0) throw new Error("Invalid recorded spending");
  if (total > budgetUsd) throw new Error("Monthly budget exceeded");
}

export function createJob(db: Db, options: JobOptions, budgetUsd: number) {
  const parsed = JobOptionsSchema.parse(options);
  return db.transaction((tx) => {
    checkBudget(db, budgetUsd);
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      topicId: null,
      status: "queued" as const,
      currentStage: null,
      error: null,
      options: parsed,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(jobs).values(job).run();
    tx.insert(jobStages)
      .values(STAGE_NAMES.map((stage) => ({ jobId: job.id, stage, status: "pending" as const })))
      .run();
    return job;
  });
}

export function startJob(db: Db, id: string, budgetUsd: number): void {
  db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new Error("Job not found");
    if (job.status === "running") throw new Error("Job is already running");
    if (job.status === "succeeded" || job.status === "cancelled")
      throw new Error(`Cannot start ${job.status} job`);
    checkBudget(db, budgetUsd);
    tx.update(jobs)
      .set({ status: "running", error: null, updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id))
      .run();
  });
}

export function cancelJob(db: Db, id: string): void {
  db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new Error("Job not found");
    if (job.status === "succeeded" || job.status === "failed")
      throw new Error(`Cannot cancel ${job.status} job`);
    if (job.status === "running" && job.currentStage === "publish")
      throw new Error("Cannot cancel job during publish");
    tx.update(jobs)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id))
      .run();
  });
}

/** Persist the stage transition; cancellation is cooperative between provider calls. */
export async function runJobStage<T>(
  db: Db,
  id: string,
  stage: StageName,
  run: () => Promise<StageResult<T>>,
): Promise<StageResult<T>> {
  const where = and(eq(jobStages.jobId, id), eq(jobStages.stage, stage));
  db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job || job.status !== "running") throw new Error(`Job is ${job?.status ?? "not found"}`);
    const now = new Date().toISOString();
    tx.update(jobs).set({ currentStage: stage, updatedAt: now }).where(eq(jobs.id, id)).run();
    tx.update(jobStages)
      .set({ status: "running", startedAt: now, finishedAt: null, error: null })
      .where(where)
      .run();
  });
  try {
    const result = await run();
    const cancelled = db.transaction((tx) => {
      for (const item of result.usage) recordLlmUsage(db, item, { jobId: id });
      const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!job || job.status !== "running") return true;
      tx.update(jobStages)
        .set({
          status: result.skipped ? "skipped" : "done",
          inputHash: result.inputHash,
          finishedAt: new Date().toISOString(),
          error: null,
        })
        .where(where)
        .run();
      return false;
    });
    if (cancelled) throw new Error("Job cancelled during stage");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.transaction((tx) => {
      const now = new Date().toISOString();
      tx.update(jobStages)
        .set({ status: "failed", finishedAt: now, error: message })
        .where(where)
        .run();
      tx.update(jobs)
        .set({ status: "failed", error: message, updatedAt: now })
        .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
        .run();
    });
    throw error;
  }
}

/**
 * Reports the usage of every call the moment it returns, and of failed calls that were
 * billed anyway. A stage only hands its usage over when it succeeds, so going through the
 * stage result would lose what was spent before a failure, a cancellation or a crash.
 */
export function meterLlm(llm: LlmProvider, onUsage: (usage: Usage) => void): LlmProvider {
  return {
    ...(llm.localCacheIdentity === undefined ? {} : { localCacheIdentity: llm.localCacheIdentity }),
    async generateObject(request) {
      let result;
      try {
        result = await llm.generateObject(request);
      } catch (error) {
        const usage = usageOfFailedCall(error);
        if (usage) onUsage(usage);
        throw error;
      }
      onUsage(result.usage);
      return result;
    },
  };
}

export interface GenerateDeps {
  db: Db;
  providers: import("../providers/index.ts").Providers;
  dataDir: string;
  budgetUsd: number;
  voice: string;
  profile: string;
  llmName: string;
  ttsName: string;
  nativeLang: string;
}

/** Run the standard pipeline. Providers must be free: paid usage is not safely priced yet. */
export async function generateJob(
  deps: GenerateDeps,
  id: string,
  options: { stopAfterScript?: boolean } = {},
): Promise<void> {
  const { db } = deps;
  // Every LLM call is written to `usage` as it completes; see `meterLlm`.
  const providers = {
    ...deps.providers,
    llm: meterLlm(deps.providers.llm, (usage) => recordLlmUsage(db, usage, { jobId: id })),
  };
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new Error("Job not found");
  if (job.options.mode !== "standard")
    throw new Error("Only standard mode is supported by this runner");
  const { mkdir, readFile, copyFile, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { EpisodeSchema, EPISODE_SCHEMA_VERSION } = await import("shared");
  const { episodes } = await import("../db/schema.ts");
  const { assembleAudio } = await import("../audio/assemble.ts");
  const { runPlanStage } = await import("./plan.ts");
  const { runSearchStage } = await import("./search.ts");
  const { runExtractStage } = await import("./extract.ts");
  const { runNotesStage } = await import("./notes.ts");
  const { runScriptStage } = await import("./script.ts");
  const { runReviewStage } = await import("./review.ts");
  const { hashInputs } = await import("./artifacts.ts");
  const workDir = path.join(deps.dataDir, "jobs", id);
  // The meter has already recorded the stage's usage, so it must not be recorded again.
  const stage = <T>(name: StageName, fn: () => Promise<StageResult<T>>) =>
    runJobStage(db, id, name, async () => ({ ...(await fn()), usage: [] }));
  const uncached = <T>(artifact: T): StageResult<T> => ({
    artifact,
    usage: [],
    skipped: false,
    inputHash: hashInputs(artifact),
  });
  startJob(db, id, deps.budgetUsd);
  const plan = (
    await stage("plan", () => runPlanStage({ workDir, llm: providers.llm }, job.options))
  ).artifact;
  const candidates = (
    await stage("search", () => runSearchStage({ workDir, search: providers.search }, { plan }))
  ).artifact;
  const sources = (
    await stage("extract", () =>
      runExtractStage({ workDir, extractor: providers.extractor }, { candidates }),
    )
  ).artifact;
  const notes = (
    await stage("notes", () =>
      runNotesStage(
        {
          workDir,
          llm: providers.llm,
          shouldContinue: () =>
            db.select().from(jobs).where(eq(jobs.id, id)).get()?.status === "running",
        },
        { title: job.options.title, plan, sources },
      ),
    )
  ).artifact;
  const script = (
    await stage("script", () =>
      runScriptStage(
        { workDir, llm: providers.llm },
        { plan, notes, sources, lang: job.options.lang, mode: "standard" },
      ),
    )
  ).artifact;
  if (options.stopAfterScript) {
    await stage("review", async () => {
      throw new Error("Interrupted after script");
    });
  }
  const reviewed = (
    await stage("review", () =>
      runReviewStage(
        { workDir, llm: providers.llm },
        { script, notes, sources, plan, noReview: job.options.review === false },
      ),
    )
  ).artifact.script;
  const wavPaths = (
    await stage("tts", async () =>
      uncached(
        await Promise.all(
          reviewed.segments.map(
            async (segment) =>
              (
                await providers.tts.synthesize({
                  text: segment.text,
                  lang: segment.lang,
                  voice: deps.voice,
                  rate: segment.rate ?? 1,
                })
              ).wavPath,
          ),
        ),
      ),
    )
  ).artifact;
  const audioPath = path.join(workDir, "audio.m4a");
  const audio = (
    await stage("assemble", async () =>
      uncached(
        await assembleAudio({
          segments: reviewed.segments,
          chapters: reviewed.chapters,
          wavPaths,
          outputPath: audioPath,
        }),
      ),
    )
  ).artifact;
  await stage("publish", async () => {
    const dir = path.join(deps.dataDir, "episodes", id);
    await mkdir(dir, { recursive: true });
    const buffer = await readFile(audioPath);
    const createdAt = job.createdAt;
    const episode = EpisodeSchema.parse({
      schemaVersion: EPISODE_SCHEMA_VERSION,
      id,
      title: reviewed.title,
      summary: reviewed.summary,
      createdAt,
      durationMs: audio.durationMs,
      mode: "standard",
      lang: job.options.lang,
      nativeLang: deps.nativeLang,
      audio: {
        file: "audio.m4a",
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      },
      segments: audio.segments,
      chapters: audio.chapters,
      sources: sources.sources,
      generation: {
        profile: deps.profile,
        llm: deps.llmName,
        tts: deps.ttsName,
        voice: deps.voice,
        costUsd: 0,
      },
    });
    await copyFile(audioPath, path.join(dir, "audio.m4a"));
    await writeFile(
      path.join(dir, "episode.json"),
      `${JSON.stringify(episode, null, 2)}
`,
    );
    db.insert(episodes)
      .values({
        id,
        topicId: null,
        title: episode.title,
        summary: episode.summary,
        mode: episode.mode,
        lang: episode.lang,
        durationMs: episode.durationMs,
        createdAt,
        path: dir,
      })
      .onConflictDoNothing()
      .run();
    return uncached({ id });
  });
  db.update(jobs)
    .set({ status: "succeeded", updatedAt: new Date().toISOString() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .run();
}
