// Shutdown may ask to cancel a job that has already reached a terminal state while the
// runner still holds it as active. Two ways in are covered here:
// - a stage announces its failure synchronously, after the job row is already `failed` and
//   before the runner lets go of the job, so a listener on that event lands in the window;
// - an operator marks the job interrupted while its provider call is still in flight.
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import type { ServerEvent } from "shared";
import { buildApp } from "../src/app.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { CancelledAfterStage, JobAlreadyFinished } from "../src/pipeline/cancellation.ts";
import { cancelJob, markJobInterrupted } from "../src/pipeline/runner.ts";
import { registerRunnerShutdown } from "../src/shutdown.ts";
import { fakeGeneration, type FakeGeneration } from "./generation-fakes.ts";

const request = { title: "Bees", brief: "", mode: "standard" as const, lang: "en", minutes: 1 };
const status = (f: FakeGeneration, id: string) =>
  (f.db.$client.prepare("select status from jobs where id = ?").get(id) as { status: string }).status;

type JobProgress = { id: string; status?: string };
function jobProgress(events: EventEmitter): JobProgress[] {
  const progress: JobProgress[] = [];
  events.on("job-progress", (id: string, entry: { kind: string; status?: string }) => {
    if (entry.kind === "job") progress.push({ id, status: entry.status });
  });
  return progress;
}

// The fake generation's own stage controls follow its pre-created job, not runner jobs.
function failingLlm(f: FakeGeneration): void {
  f.deps.providers.llm = { async generateObject() { throw new Error("connection lost"); } };
}
/** Holds the first call open; once released it stops without leaving external work behind. */
function heldLlm(f: FakeGeneration): { entered: Promise<void>; release(): void } {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.deps.providers.llm = { async generateObject() { entered(); await gate; throw new CancelledAfterStage("fixture stopped"); } };
  return { entered: started, release };
}

/** Runs `act` once, inside the window between "job row failed" and "runner released it". */
function onStageFailure<T>(events: EventEmitter, act: (jobId: string) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    events.on("event", (event: ServerEvent) => {
      if (done || event.type !== "job-stage" || event.status !== "failed") return;
      done = true;
      try { resolve(act(event.jobId)); } catch (error) { reject(error as Error); }
    });
  });
}

test("stopping generation tolerates an active job that has just failed", async () => {
  const f = fakeGeneration();
  failingLlm(f);
  const events = new EventEmitter();
  const progress = jobProgress(events);
  const runner = createDesktopRunner(f.deps, events);
  let window: { status: string; busy: boolean } | undefined;
  try {
    const stopped = onStageFailure(events, (jobId) => {
      window = { status: status(f, jobId), busy: runner.isBusy!(jobId) };
      return runner.stopGeneration();
    });
    const job = await runner.create(request);
    expect(await stopped).toBe(true);
    expect(window).toEqual({ status: "failed", busy: true });
    expect(status(f, job.id)).toBe("failed");
    expect(progress).not.toContainEqual({ id: job.id, status: "cancelled" });
    expect(progress).toContainEqual({ id: job.id, status: "failed" });
    expect(await runner.close()).toBe(true);
    // The provider failure itself still leaves recovery blocked, exactly as without the race.
    const guard = openDesktopGuard(f.dir);
    try { expect(() => guard.begin()).toThrow(/manual recovery/i); } finally { guard.close(false); }
  } finally { await runner.close().catch(() => {}); f.close(); }
}, 20_000);

test("server shutdown completes in order when the active job is already failed", async () => {
  const f = fakeGeneration();
  const llm = heldLlm(f);
  const events = new EventEmitter();
  const runner = createDesktopRunner(f.deps, events);
  const app = buildApp({ db: f.db, runner, events });
  const order: string[] = [];
  const session = { async shutdown() { order.push(`session, database open: ${f.db.$client.open}`); } };
  const close = runner.close.bind(runner);
  runner.close = async () => { order.push(`runner, database open: ${f.db.$client.open}`); return close(); };
  registerRunnerShutdown(app, f.db, runner, session);
  const exitCode = process.exitCode;
  try {
    const active = await runner.create(request);
    await llm.entered;
    markJobInterrupted(f.db, active.id);
    expect(status(f, active.id)).toBe("failed");
    const closing = app.close();
    void closing.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    llm.release();
    await closing;
    expect(order).toEqual(["session, database open: true", "runner, database open: false"]);
    expect(f.db.$client.open).toBe(false);
    expect(process.exitCode).toBe(exitCode);
    const guard = openDesktopGuard(f.dir);
    try { expect(() => guard.begin()).not.toThrow(); } finally { guard.close(true); }
  } finally {
    llm.release();
    process.exitCode = exitCode;
    await app.close().catch(() => {});
    await close().catch(() => {});
    f.close();
  }
}, 20_000);

test("shutdown skips an already-failed active job and still cancels the queued one", async () => {
  const f = fakeGeneration();
  const llm = heldLlm(f);
  const events = new EventEmitter();
  const progress = jobProgress(events);
  const runner = createDesktopRunner(f.deps, events);
  try {
    const active = await runner.create(request);
    await llm.entered;
    const queued = await runner.create(request);
    markJobInterrupted(f.db, active.id);
    const stopping = runner.stopGeneration();
    void stopping.catch(() => {});
    llm.release();
    expect(await stopping).toBe(true);
    expect(status(f, active.id)).toBe("failed");
    expect(status(f, queued.id)).toBe("cancelled");
    expect(progress).toContainEqual({ id: queued.id, status: "cancelled" });
    expect(progress).not.toContainEqual({ id: active.id, status: "cancelled" });
  } finally { llm.release(); await runner.close().catch(() => {}); f.close(); }
}, 20_000);

test("shutdown still surfaces a cancellation failure that is not an already-finished job", async () => {
  const f = fakeGeneration();
  const llm = heldLlm(f);
  const runner = createDesktopRunner(f.deps, new EventEmitter());
  try {
    const job = await runner.create(request);
    await llm.entered;
    f.db.$client.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'cancel rejected'); END");
    try {
      await expect(runner.stopGeneration()).rejects.toThrow(/cancel rejected/);
      await expect(runner.close()).rejects.toThrow(/cancel rejected/);
    } finally { f.db.$client.exec("DROP TRIGGER reject_cancel"); }
    expect(status(f, job.id)).toBe("running");
  } finally { llm.release(); await runner.close().catch(() => {}); f.close(); }
}, 20_000);

test("an explicit cancel of a finished job is still refused with the same messages", async () => {
  const f = fakeGeneration();
  failingLlm(f);
  const events = new EventEmitter();
  const runner = createDesktopRunner(f.deps, events);
  // Reaches cancelJob for any job, as a runner that still owns the finished job would.
  const app = buildApp({ db: f.db, events, runner: { ...runner, async cancel(id) { cancelJob(f.db, id); return runner.cancel(id); } } });
  try {
    const refused = onStageFailure(events, (jobId) => runner.cancel(jobId).then(() => undefined, (error: unknown) => error));
    const job = await runner.create(request);
    const error = await refused;
    expect(error).toBeInstanceOf(JobAlreadyFinished);
    expect((error as Error).message).toBe("Cannot cancel failed job");
    expect(status(f, job.id)).toBe("failed");
    const failed = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/cancel` });
    expect([failed.statusCode, failed.json()]).toEqual([409, { error: "Cannot cancel failed job" }]);
    f.db.$client.prepare("update jobs set status = 'succeeded' where id = ?").run(f.jobId);
    const succeeded = await app.inject({ method: "POST", url: `/api/jobs/${f.jobId}/cancel` });
    expect([succeeded.statusCode, succeeded.json()]).toEqual([409, { error: "Cannot cancel succeeded job" }]);
    f.db.$client.prepare("update jobs set status = 'running', current_stage = 'publish' where id = ?").run(f.jobId);
    const publishing = await app.inject({ method: "POST", url: `/api/jobs/${f.jobId}/cancel` });
    expect([publishing.statusCode, publishing.json()]).toEqual([409, { error: "Cannot cancel job during publish" }]);
    let caught: unknown;
    try { cancelJob(f.db, f.jobId); } catch (thrown) { caught = thrown; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(JobAlreadyFinished);
  } finally { await app.close(); await runner.close().catch(() => {}); f.close(); }
}, 20_000);
