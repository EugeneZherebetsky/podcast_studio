import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { JobOptionsSchema, STAGE_NAMES, type JobOptions } from "shared";
import type { Db } from "../db/index.ts";
import { jobs, jobStages } from "../db/schema.ts";
import { monthTotalCostUsd } from "../usage.ts";

/** Create a queued job only while recorded spending is within the monthly budget. */
export function createJob(db: Db, options: JobOptions, budgetUsd: number) {
  const parsed = JobOptionsSchema.parse(options);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error("Invalid budget");
  return db.transaction((tx) => {
    if (monthTotalCostUsd(db) > budgetUsd) throw new Error("Monthly budget exceeded");
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
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error("Invalid budget");
  db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new Error("Job not found");
    if (job.status === "running") throw new Error("Job is already running");
    if (job.status === "succeeded" || job.status === "cancelled")
      throw new Error(`Cannot start ${job.status} job`);
    if (monthTotalCostUsd(db) > budgetUsd) throw new Error("Monthly budget exceeded");
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
