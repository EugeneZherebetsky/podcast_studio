import { afterEach, expect, test } from "vitest";
import { runPlanStage } from "../src/pipeline/plan.ts";
import { FakeLlmProvider } from "../src/providers/llm/fake.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/index.ts";
import { episodes, jobs, jobStages, usage } from "../src/db/schema.ts";
import { cancelJob, createJob, runJobStage, startJob } from "../src/pipeline/runner.ts";

const db = openDatabase(":memory:");
afterEach(() => db.$client.exec("DELETE FROM jobs; DELETE FROM usage"));
const options = { title: "Bees", brief: "", mode: "standard" as const, lang: "en", minutes: 8 };
const getJob = (id: string) => db.select().from(jobs).where(eq(jobs.id, id)).get()!;
const stage = (id: string, name: string) =>
  db
    .select()
    .from(jobStages)
    .all()
    .find((s) => s.jobId === id && s.stage === name)!;

test("creates queued jobs with pending stages and refuses excessive spending", () => {
  const job = createJob(db, options, 20);
  expect(job.status).toBe("queued");
  expect(
    db
      .select()
      .from(jobStages)
      .all()
      .filter((s) => s.jobId === job.id),
  ).toHaveLength(9);
  db.insert(usage)
    .values({ ts: new Date().toISOString(), provider: "fake", kind: "llm", units: 1, costUsd: 21 })
    .run();
  expect(() => createJob(db, options, 20)).toThrow(/budget/i);
  expect(() => startJob(db, job.id, 20)).toThrow(/budget/i);
});

test("records successful stage and usage and persists cancellation", async () => {
  const job = createJob(db, options, 20);
  startJob(db, job.id, 20);
  expect(() => startJob(db, job.id, 20)).toThrow(/running/i);
  const result = await runJobStage(db, job.id, "plan", async () => ({
    artifact: { answer: 42 },
    skipped: false,
    inputHash: "abc",
    usage: [{ provider: "fake", model: "fake", inputTokens: 3, outputTokens: 4, costUsd: 0.1 }],
  }));
  expect(result.artifact.answer).toBe(42);
  expect(stage(job.id, "plan")).toMatchObject({ status: "done", inputHash: "abc" });
  expect(db.select().from(usage).all()).toMatchObject([{ jobId: job.id, units: 7, costUsd: 0.1 }]);
  cancelJob(db, job.id);
  expect(getJob(job.id).status).toBe("cancelled");
  await expect(
    runJobStage(db, job.id, "search", async () => {
      throw Error("must not run");
    }),
  ).rejects.toThrow(/cancel/i);
});

test("a cached real plan can be resumed without another model call or usage row", async () => {
  const dir = makeTempDir();
  try {
    const llm = new FakeLlmProvider({
      responses: [{ queries: ["a", "b", "c", "d", "e"], angle: "Bees" }],
    });
    const job = createJob(db, options, 20);
    startJob(db, job.id, 20);
    const run = () =>
      runJobStage(db, job.id, "plan", () => runPlanStage({ workDir: dir, llm }, options));
    expect((await run()).skipped).toBe(false);
    await expect(
      runJobStage(db, job.id, "search", async () => {
        throw Error("offline");
      }),
    ).rejects.toThrow("offline");
    startJob(db, job.id, 20);
    expect((await run()).skipped).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(db.select().from(usage).all()).toHaveLength(1);
  } finally {
    removeTempDir(dir);
  }
});

test("records a failed stage and leaves the job resumable", async () => {
  const job = createJob(db, options, 20);
  startJob(db, job.id, 20);
  await expect(
    runJobStage(db, job.id, "plan", async () => {
      throw new Error("network unavailable");
    }),
  ).rejects.toThrow(/network unavailable/);
  expect(getJob(job.id)).toMatchObject({
    status: "failed",
    currentStage: "plan",
    error: "network unavailable",
  });
  expect(stage(job.id, "plan")).toMatchObject({ status: "failed", error: "network unavailable" });
  startJob(db, job.id, 20);
  expect(getJob(job.id).status).toBe("running");
});

test("publication rejects cancellation and does not report a visible episode as cancelled", async () => {
  const job = createJob(db, options, 20);
  startJob(db, job.id, 20);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const running = runJobStage(db, job.id, "publish", async () => {
    await waiting;
    db.insert(episodes)
      .values({
        id: job.id,
        topicId: null,
        title: "Bees",
        summary: "",
        mode: "standard",
        lang: "en",
        durationMs: 1,
        createdAt: job.createdAt,
        path: "fake",
      })
      .run();
    return { artifact: { id: job.id }, skipped: false, inputHash: "abc", usage: [] };
  });
  expect(() => cancelJob(db, job.id)).toThrow(/cannot cancel.*publish/i);
  finish();
  await expect(running).resolves.toMatchObject({ artifact: { id: job.id } });
  expect(getJob(job.id).status).toBe("running");
  expect(stage(job.id, "publish").status).toBe("done");
  expect(db.select().from(episodes).where(eq(episodes.id, job.id)).get()).toBeDefined();
  expect(() => cancelJob(db, job.id)).toThrow(/cannot cancel.*publish/i);
});

test("cancellation before publication prevents the callback", async () => {
  const job = createJob(db, options, 20);
  startJob(db, job.id, 20);
  cancelJob(db, job.id);
  let called = false;
  await expect(
    runJobStage(db, job.id, "publish", async () => {
      called = true;
      return { artifact: {}, skipped: false, inputHash: "abc", usage: [] };
    }),
  ).rejects.toThrow(/cancel/i);
  expect(called).toBe(false);
  expect(stage(job.id, "publish").status).toBe("pending");
  expect(getJob(job.id).status).toBe("cancelled");
  expect(db.select().from(episodes).where(eq(episodes.id, job.id)).get()).toBeUndefined();
});

test("publication callback errors still fail the job", async () => {
  const job = createJob(db, options, 20);
  startJob(db, job.id, 20);
  await expect(
    runJobStage(db, job.id, "publish", async () => {
      expect(() => cancelJob(db, job.id)).toThrow(/cannot cancel.*publish/i);
      throw new Error("publish failed");
    }),
  ).rejects.toThrow("publish failed");
  expect(getJob(job.id)).toMatchObject({ status: "failed", error: "publish failed" });
  expect(stage(job.id, "publish")).toMatchObject({ status: "failed", error: "publish failed" });
});

test("cancellation during a stage does not report its successful completion", async () => {
  const job = createJob(db, options, 20);
  startJob(db, job.id, 20);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const running = runJobStage(db, job.id, "plan", async () => {
    await waiting;
    return { artifact: {}, skipped: false, inputHash: "abc", usage: [] };
  });
  cancelJob(db, job.id);
  finish();
  await expect(running).rejects.toThrow(/cancel/i);
  expect(getJob(job.id).status).toBe("cancelled");
  expect(stage(job.id, "plan").status).toBe("failed");
});
