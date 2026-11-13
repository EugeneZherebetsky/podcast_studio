import { eq } from "drizzle-orm";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { episodes, jobs } from "../src/db/schema.ts";
import { invalidateStageFiles } from "../src/pipeline/artifacts.ts";
import {
  cancelJob,
  generateJob,
  markJobInterrupted,
  runJobStage as executeJobStage,
  startJob,
} from "../src/pipeline/runner.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

const runJobStage: OmitOwner = (db, id, stage, run) =>
  executeJobStage(
    db,
    id,
    stage,
    run,
    db.select().from(jobs).where(eq(jobs.id, id)).get()!.ownerToken!,
  );
type OmitOwner = <T>(
  db: import("../src/db/index.ts").Db,
  id: string,
  stage: import("shared").StageName,
  run: () => Promise<import("../src/pipeline/artifacts.ts").StageResult<T>>,
) => Promise<import("../src/pipeline/artifacts.ts").StageResult<T>>;

test(
  "a run killed after the script stage cannot be resumed while publication is unfenced",
  async () => {
    const run = fakeGeneration({ review: true });
    try {
      // The process "dies" inside the review stage: its LLM call never comes back, and
      // nothing gets the chance to mark the job or the stage as failed.
      run.llm.hangIn = "review";
      void generateJob(run.deps, run.jobId).catch(() => undefined);
      await run.llm.hung;
      expect(run.job()).toMatchObject({ status: "running", currentStage: "review" });
      expect(run.stageStatus("script")).toBe("done");
      expect(run.stageStatus("review")).toBe("running");
      const beforeKill = [...run.llm.stages];
      expect(new Set(beforeKill)).toEqual(new Set(["plan", "notes", "script"]));
      const searches = run.providers.search.calls.length;

      // A job marked `running` may still have a live executor: it is never taken over.
      run.llm.hangIn = undefined;
      await expect(generateJob(run.deps, run.jobId)).rejects.toThrow(/disabled/i);
      await expect(generateJob(run.deps, run.jobId, { fromStage: "plan" })).rejects.toThrow(
        /disabled/i,
      );
      expect(run.job().status).toBe("running");
      expect(run.llm.stages).toEqual(beforeKill);
      expect(existsSync(path.join(run.workDir, "script.json"))).toBe(true);

      // Only the operator's statement that the process is gone makes it resumable.
      markJobInterrupted(run.db, run.jobId);
      expect(run.job()).toMatchObject({ status: "failed", currentStage: "review" });
      expect(run.job().error).toMatch(/interrupted/i);
      expect(run.stageStatus("review")).toBe("failed");

      await expect(generateJob(run.deps, run.jobId)).rejects.toThrow(/recovery is disabled/i);
      expect(run.job().status).toBe("failed");
      expect(run.llm.stages).toEqual(beforeKill);
      expect(run.providers.search.calls).toHaveLength(searches);
    } finally {
      run.close();
    }
  },
  GENERATION_TIMEOUT_MS,
);

test("only a job whose executor is known to be gone can be marked interrupted", () => {
  const run = fakeGeneration();
  try {
    expect(() => markJobInterrupted(run.db, "missing")).toThrow(/not found/i);
    expect(() => markJobInterrupted(run.db, run.jobId)).toThrow(/queued/i);
    startJob(run.db, run.jobId, 20);
    markJobInterrupted(run.db, run.jobId);
    expect(run.job().status).toBe("failed");
    expect(() => markJobInterrupted(run.db, run.jobId)).toThrow(/failed/i);
  } finally {
    run.close();
  }
});

test("a cancelled job can be resumed only once its stage has stopped", async () => {
  const run = fakeGeneration();
  try {
    startJob(run.db, run.jobId, 20);
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stage = runJobStage(run.db, run.jobId, "plan", async () => {
      await waiting;
      return { artifact: {}, skipped: false, inputHash: "abc", usage: [] };
    });
    cancelJob(run.db, run.jobId);
    // The stage has not noticed the cancellation yet: starting now would run it twice.
    expect(() => startJob(run.db, run.jobId, 20)).toThrow(/has not stopped/i);
    expect(run.job().status).toBe("cancelled");
    finish();
    await expect(stage).rejects.toThrow(/cancel/i);
    startJob(run.db, run.jobId, 20);
    expect(run.job().status).toBe("running");
  } finally {
    run.close();
  }
});

test("a cancelled job whose process died mid-stage needs the same explicit statement", async () => {
  const run = fakeGeneration();
  try {
    startJob(run.db, run.jobId, 20);
    void runJobStage(run.db, run.jobId, "plan", () => new Promise<never>(() => {}));
    cancelJob(run.db, run.jobId);
    expect(() => startJob(run.db, run.jobId, 20)).toThrow(/has not stopped/i);
    markJobInterrupted(run.db, run.jobId);
    expect(run.job().status).toBe("cancelled");
    expect(run.stageStatus("plan")).toBe("failed");
    startJob(run.db, run.jobId, 20);
    expect(run.job().status).toBe("running");
  } finally {
    run.close();
  }
});

test(
  "retry from a stage is disabled without deleting cached files",
  async () => {
    const run = fakeGeneration();
    try {
      await expect(generateJob(run.deps, run.jobId, { stopAfterScript: true })).rejects.toThrow(
        /interrupt/i,
      );
      const before = run.llm.stages.length;
      const searches = run.providers.search.calls.length;
      const scriptFile = path.join(run.workDir, "script.json");
      writeFileSync(scriptFile, readFileSync(scriptFile, "utf8").replace("About bees", "Stale"));

      await expect(
        generateJob(run.deps, run.jobId, { fromStage: "narrate" as never }),
      ).rejects.toThrow(/unknown stage/i);
      expect(run.job().status).toBe("failed");
      expect(run.llm.stages).toHaveLength(before);

      await expect(generateJob(run.deps, run.jobId, { fromStage: "script" })).rejects.toThrow(
        /disabled/i,
      );
      expect(run.job().status).toBe("failed");
      expect(run.llm.stages).toHaveLength(before);
      expect(run.providers.search.calls).toHaveLength(searches);
      expect(readFileSync(scriptFile, "utf8")).toContain("Stale");
    } finally {
      run.close();
    }
  },
  GENERATION_TIMEOUT_MS,
);

test(
  "retry and resume are refused once the episode is listed",
  async () => {
    const run = fakeGeneration();
    try {
      await expect(
        generateJob(run.deps, run.jobId, {
          afterPublishStep: (step) => {
            if (step === "recorded") throw new Error("crash after recorded");
          },
        }),
      ).rejects.toThrow("crash after recorded");
      expect(run.job().status).toBe("failed");
      const calls = run.llm.stages.length;
      const audio = path.join(run.dir, "episodes", run.jobId, "audio.m4a");
      const published = readFileSync(audio);

      await expect(generateJob(run.deps, run.jobId, { fromStage: "script" })).rejects.toThrow(
        /already published/i,
      );
      expect(run.job().status).toBe("failed");
      expect(existsSync(path.join(run.workDir, "script.json"))).toBe(true);

      await expect(generateJob(run.deps, run.jobId)).rejects.toThrow(/recovery is disabled/i);
      expect(run.job().status).toBe("failed");
      expect(run.llm.stages).toHaveLength(calls);
      expect(readFileSync(audio).equals(published)).toBe(true);
      expect(run.db.select().from(episodes).all()).toHaveLength(1);
    } finally {
      run.close();
    }
  },
  GENERATION_TIMEOUT_MS,
);

test("invalidating from a stage removes its files and later ones, and nothing earlier", async () => {
  const dir = makeTempDir();
  try {
    const files = [
      "plan.json",
      "plan.inputs.sha256",
      "candidates.json",
      "sources.json",
      "sources.inputs.sha256",
      "notes.json",
      "notes.inputs.sha256",
      "notes-map/a.json",
      "script.json",
      "script.inputs.sha256",
      "script-chapters/a.json",
      "review.json",
      "review.inputs.sha256",
      "review-segments/a.json",
      "reviewed-script.json",
      "audio.m4a",
    ];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), "x");
    }
    await invalidateStageFiles(dir, "script");
    expect(readdirSync(dir).sort()).toEqual([
      "candidates.json",
      "notes-map",
      "notes.inputs.sha256",
      "notes.json",
      "plan.inputs.sha256",
      "plan.json",
      "sources.inputs.sha256",
      "sources.json",
    ]);
    await invalidateStageFiles(dir, "plan");
    expect(readdirSync(dir)).toEqual([]);
    await invalidateStageFiles(path.join(dir, "never-created"), "plan"); // nothing to do
  } finally {
    removeTempDir(dir);
  }
});
