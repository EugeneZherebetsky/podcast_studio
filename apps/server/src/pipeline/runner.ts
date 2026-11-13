import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { JobOptionsSchema, STAGE_NAMES, type JobOptions, type StageName } from "shared";
import type { Db } from "../db/index.ts";
import { episodes, jobs, jobStages } from "../db/schema.ts";
import { usageOfFailedCall, type LlmProvider, type Usage } from "../providers/llm/interface.ts";
import { monthTotalCostUsd, recordLlmUsage } from "../usage.ts";
import {
  ARTIFACT_FILES,
  artifactPaths,
  STAGE_SCRATCH,
  type CachedStageName,
  type StageResult,
} from "./artifacts.ts";
import type { PublishStep } from "./publish.ts";

function rejectLink(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Symbolic link rejected: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

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
 * - A `running` job is never taken over without an explicit interruption. Each claim
 *   receives a new token so an older executor cannot update its database state.
 */
export function startJob(db: Db, id: string, budgetUsd: number, queuedOnly = false): string {
  const ownerToken = randomUUID();
  db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new Error("Job not found");
    if (queuedOnly && job.status !== "queued")
      throw new Error("Job recovery is disabled: filesystem publication is not fenced");
    if (job.status === "running")
      throw new Error(
        "Job is already running; if its process has stopped, mark the job as interrupted first",
      );
    if (job.status === "succeeded") throw new Error("Cannot start succeeded job");
    if (job.status === "cancelled" && runningStages(tx, id).length > 0)
      throw new Error("Job was cancelled but its current stage has not stopped yet");
    checkBudget(db, budgetUsd);
    tx.update(jobs)
      .set({ status: "running", ownerToken, error: null, updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id))
      .run();
  });
  return ownerToken;
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
    if (job.currentStage === "publish" && job.status === "running")
      throw new Error("Cannot interrupt during publish: filesystem publication is not fenced");
    const stuck = job.status === "cancelled" && runningStages(tx, id).length > 0;
    if (job.status !== "running" && !stuck)
      throw new Error(`Job is ${job.status}: there is no interrupted run to clear`);
    const now = new Date().toISOString();
    tx.update(jobStages)
      .set({ status: "failed", finishedAt: now, error: INTERRUPTED })
      .where(and(eq(jobStages.jobId, id), eq(jobStages.status, "running")))
      .run();
    if (job.status === "cancelled")
      tx.update(jobs).set({ ownerToken: null }).where(eq(jobs.id, id)).run();
    if (job.status === "running")
      tx.update(jobs)
        .set({ status: "failed", ownerToken: null, error: INTERRUPTED, updatedAt: now })
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
  ownerToken: string,
  promote?: () => void,
): Promise<StageResult<T>> {
  const where = and(eq(jobStages.jobId, id), eq(jobStages.stage, stage));
  db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job || job.status !== "running" || job.ownerToken !== ownerToken)
      throw new Error(`Job is ${job?.status ?? "not found"}`);
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
      if (!job || job.status !== "running" || job.ownerToken !== ownerToken) return true;
      // Acquire SQLite's write lock before touching files, including in WAL mode.
      tx.update(jobs).set({ updatedAt: job.updatedAt }).where(eq(jobs.id, id)).run();
      promote?.();
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
      const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!job || job.ownerToken !== ownerToken) return;
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
  /** Currently disabled until retry filesystem writes can be fenced. */
  fromStage?: StageName;
  /** Test seam: fail in place of the review stage, as an interruption after stage 5. */
  stopAfterScript?: boolean;
  /** Test seam: see `PublishOptions.afterStep`. */
  afterPublishStep?: (step: PublishStep) => void | Promise<void>;
}

/**
 * Run a new standard pipeline. Recovery is disabled until filesystem writes are fenced.
 * Providers must be free: paid usage is not safely priced yet.
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

  const { EPISODE_SCHEMA_VERSION } = await import("shared");
  const { publishEpisode } = await import("./publish.ts");
  const { assembleAudio } = await import("../audio/assemble.ts");
  const { runPlanStage } = await import("./plan.ts");
  const { runSearchStage } = await import("./search.ts");
  const { runExtractStage } = await import("./extract.ts");
  const { runNotesStage } = await import("./notes.ts");
  const { runScriptStage } = await import("./script.ts");
  const { runReviewStage } = await import("./review.ts");
  const { hashInputs, SCRATCH_FILES } = await import("./artifacts.ts");
  const canonicalDir = path.join(deps.dataDir, "jobs", id);
  // The meter has already recorded the stage's usage, so it must not be recorded again.
  const stage = <T>(name: StageName, fn: () => Promise<StageResult<T>>) =>
    runJobStage(
      db,
      id,
      name,
      async () => ({ ...(await fn()), usage: [] }),
      ownerToken,
      () => {
        const files = [...(STAGE_SCRATCH[name] ?? [])];
        if (name in ARTIFACT_FILES) {
          const paths = artifactPaths(workDir, name as CachedStageName);
          const target = artifactPaths(canonicalDir, name as CachedStageName);
          rmSync(target.hash, { force: true });
          files.push(path.basename(paths.artifact), path.basename(paths.hash));
        }
        for (const file of files) {
          const source = path.join(workDir, file);
          if (!existsSync(source)) continue;
          const target = path.join(canonicalDir, file);
          rmSync(target, { recursive: true, force: true });
          cpSync(source, target, { recursive: true });
        }
      },
    );
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
  if (fromStage !== undefined)
    throw new Error("Retry is disabled: filesystem publication is not fenced");
  if (job.status !== "queued")
    throw new Error("Job recovery is disabled: filesystem publication is not fenced");
  const ownerToken = startJob(db, id, deps.budgetUsd, true);
  const workDir = path.join(canonicalDir, "runs", ownerToken);
  // Copy, never link: an abandoned executor may still write its own files.
  try {
    db.transaction((tx) => {
      const owner = tx.select().from(jobs).where(eq(jobs.id, id)).get();
      if (owner?.status !== "running" || owner.ownerToken !== ownerToken)
        throw new Error("Job ownership lost");
      tx.update(jobs).set({ updatedAt: owner.updatedAt }).where(eq(jobs.id, id)).run();
      for (const dir of [
        deps.dataDir,
        path.join(deps.dataDir, "jobs"),
        canonicalDir,
        path.join(canonicalDir, "runs"),
        workDir,
      ])
        rejectLink(dir);
      mkdirSync(workDir, { recursive: true });
      const files = [
        ...Object.keys(ARTIFACT_FILES).flatMap((stage) => {
          const paths = artifactPaths(canonicalDir, stage as CachedStageName);
          return [path.basename(paths.artifact), path.basename(paths.hash)];
        }),
        ...Object.values(STAGE_SCRATCH).flat(),
      ];
      for (const file of files) {
        const source = path.join(canonicalDir, file);
        const target = path.join(workDir, file);
        rejectLink(source);
        rejectLink(target);
        if (existsSync(source))
          cpSync(source, target, {
            recursive: true,
            filter: (src, dest) => {
              rejectLink(src);
              rejectLink(dest);
              return true;
            },
          });
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(jobs)
      .set({ status: "failed", error: message, updatedAt: new Date().toISOString() })
      .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.ownerToken, ownerToken)))
      .run();
    throw error;
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
            db
              .select()
              .from(jobs)
              .where(
                and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.ownerToken, ownerToken)),
              )
              .get() !== undefined,
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
    await stage("tts", async () => {
      const tts = providers.tts.forRun?.(path.join(workDir, "tts"));
      if (!tts) throw new Error("TTS provider does not support run isolation");
      return uncached(
        await Promise.all(
          reviewed.segments.map(
            async (segment) =>
              (
                await tts.synthesize({
                  text: segment.text,
                  lang: segment.lang,
                  voice: deps.voice,
                  rate: segment.rate ?? 1,
                })
              ).wavPath,
          ),
        ),
      );
    })
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
    .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.ownerToken, ownerToken)))
    .run();
}
