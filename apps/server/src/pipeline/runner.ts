import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { JobOptionsSchema, STAGE_NAMES, type JobOptions, type StageName } from "shared";
import type { Db } from "../db/index.ts";
import { jobs, jobStages } from "../db/schema.ts";
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
    db.transaction((tx) => {
      for (const item of result.usage) recordLlmUsage(db, item, { jobId: id });
      tx.update(jobStages)
        .set({
          status: result.skipped ? "skipped" : "done",
          inputHash: result.inputHash,
          finishedAt: new Date().toISOString(),
          error: null,
        })
        .where(where)
        .run();
    });
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
