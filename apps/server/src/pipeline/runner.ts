import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { JobOptionsSchema, STAGE_NAMES, type JobOptions, type StageName } from "shared";
import type { Db } from "../db/index.ts";
import { episodes, jobs, jobStages } from "../db/schema.ts";
import { usageOfFailedCall, type LlmProvider, type Usage } from "../providers/llm/interface.ts";
import { monthTotalCostUsd, recordLlmUsage } from "../usage.ts";
import type { StageResult } from "./artifacts.ts";
import type { PublishStep } from "./publish.ts";

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

const INTERRUPTED = "Interrupted: the process running this job stopped";

/**
 * Claims the job for the caller, atomically: of any number of callers, one gets it.
 *
 * - `queued` and `failed` jobs can be started: nothing is executing them (a job becomes
 *   `failed` only when its executor gives up).
 * - A `cancelled` job can be started once no stage is marked `running`, i.e. once its
 *   executor has noticed the cancellation and stopped.
 * - A `running` job is never taken over. The database cannot tell an executor that is
 *   still working from one whose process died (nothing records who runs a job or when it
 *   was last alive), so that takes an explicit `markJobInterrupted` first.
 */
export function startJob(db: Db, id: string, budgetUsd: number): void {
  db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new Error("Job not found");
    if (job.status === "running")
      throw new Error(
        "Job is already running; if its process has stopped, mark the job as interrupted first",
      );
    if (job.status === "succeeded") throw new Error("Cannot start succeeded job");
    if (job.status === "cancelled" && runningStages(tx, id).length > 0)
      throw new Error("Job was cancelled but its current stage has not stopped yet");
    checkBudget(db, budgetUsd);
    tx.update(jobs)
      .set({ status: "running", error: null, updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id))
      .run();
  });
}

function runningStages(tx: Pick<Db, "select">, id: string) {
  return tx
    .select()
    .from(jobStages)
    .where(and(eq(jobStages.jobId, id), eq(jobStages.status, "running")))
    .all();
}

/**
 * The operator's statement that no process is executing this job any more (it was killed,
 * or the machine went down), which is the one thing the database cannot know. A `running`
 * job becomes `failed` and can then be resumed; a `cancelled` job stuck in a stage gets
 * that stage closed. Never call this on a guess: if the old process is in fact alive, two
 * executors will work on the same job.
 */
export function markJobInterrupted(db: Db, id: string): void {
  db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new Error("Job not found");
    const stuck = job.status === "cancelled" && runningStages(tx, id).length > 0;
    if (job.status !== "running" && !stuck)
      throw new Error(`Job is ${job.status}: there is no interrupted run to clear`);
    const now = new Date().toISOString();
    tx.update(jobStages)
      .set({ status: "failed", finishedAt: now, error: INTERRUPTED })
      .where(and(eq(jobStages.jobId, id), eq(jobStages.status, "running")))
      .run();
    if (job.status === "running")
      tx.update(jobs)
        .set({ status: "failed", error: INTERRUPTED, updatedAt: now })
        .where(eq(jobs.id, id))
        .run();
  });
}

/** Retry-from-stage, database half: `fromStage` and every later stage are pending again. */
function resetStagesFrom(db: Db, id: string, fromStage: StageName): void {
  db.update(jobStages)
    .set({ status: "pending", inputHash: null, startedAt: null, finishedAt: null, error: null })
    .where(
      and(
        eq(jobStages.jobId, id),
        inArray(jobStages.stage, STAGE_NAMES.slice(STAGE_NAMES.indexOf(fromStage))),
      ),
    )
    .run();
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

export interface GenerateOptions {
  /**
   * Retry from this stage: it and every later stage run again even if their inputs are
   * unchanged; earlier stages are reused from their cached artifacts.
   */
  fromStage?: StageName;
  /** Test seam: fail in place of the review stage, as an interruption after stage 5. */
  stopAfterScript?: boolean;
  /** Test seam: see `PublishOptions.afterStep`. */
  afterPublishStep?: (step: PublishStep) => void | Promise<void>;
}

/**
 * Run the standard pipeline, or resume it: a stage whose artifact is there for the same
 * inputs is skipped, so a `failed` job continues where it stopped. Which jobs may be
 * started is decided by `startJob`. Providers must be free: paid usage is not safely
 * priced yet.
 */
export async function generateJob(
  deps: GenerateDeps,
  id: string,
  options: GenerateOptions = {},
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
  const path = await import("node:path");
  const { EPISODE_SCHEMA_VERSION } = await import("shared");
  const { publishEpisode } = await import("./publish.ts");
  const { assembleAudio } = await import("../audio/assemble.ts");
  const { runPlanStage } = await import("./plan.ts");
  const { runSearchStage } = await import("./search.ts");
  const { runExtractStage } = await import("./extract.ts");
  const { runNotesStage } = await import("./notes.ts");
  const { runScriptStage } = await import("./script.ts");
  const { runReviewStage } = await import("./review.ts");
  const { hashInputs, invalidateStageFiles, SCRATCH_FILES } = await import("./artifacts.ts");
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
  const { fromStage } = options;
  if (fromStage !== undefined) {
    if (!STAGE_NAMES.includes(fromStage)) throw new Error(`Unknown stage "${String(fromStage)}"`);
    if (job.status === "succeeded") throw new Error("Cannot start succeeded job");
    // A listed episode may already be on a device and is never replaced (see publish.ts),
    // so re-running earlier stages could only produce work that is thrown away.
    if (db.select().from(episodes).where(eq(episodes.id, id)).get())
      throw new Error(
        "Job has already published its episode; resume it without a stage to finish it",
      );
  }
  startJob(db, id, deps.budgetUsd);
  if (fromStage !== undefined) {
    // Only now that the job is ours: nothing of a job someone else runs is ever removed.
    try {
      await invalidateStageFiles(workDir, fromStage);
      resetStagesFrom(db, id, fromStage);
    } catch (error) {
      const message = `Cannot retry from ${fromStage}: ${error instanceof Error ? error.message : String(error)}`;
      db.update(jobs)
        .set({ status: "failed", error: message, updatedAt: new Date().toISOString() })
        .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
        .run();
      throw new Error(message, { cause: error });
    }
  }
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
  const audioPath = path.join(workDir, SCRATCH_FILES.assembledAudio);
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
  // Files first, the `episodes` row second, the stage and job status last: see publish.ts.
  await stage("publish", async () => {
    const published = await publishEpisode({
      db,
      dataDir: deps.dataDir,
      audioPath,
      episode: {
        schemaVersion: EPISODE_SCHEMA_VERSION,
        id,
        title: reviewed.title,
        summary: reviewed.summary,
        createdAt: job.createdAt,
        durationMs: audio.durationMs,
        mode: "standard",
        lang: job.options.lang,
        nativeLang: deps.nativeLang,
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
      },
      ...(options.afterPublishStep ? { afterStep: options.afterPublishStep } : {}),
    });
    return uncached({ id, reused: published.reused });
  });
  db.update(jobs)
    .set({ status: "succeeded", updatedAt: new Date().toISOString() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .run();
}
