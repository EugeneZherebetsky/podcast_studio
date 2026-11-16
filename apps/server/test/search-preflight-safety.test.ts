import { EventEmitter } from "node:events";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { buildApp } from "../src/app.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";
import { fakeGeneration } from "./generation-fakes.ts";

test("a topic deleted during preflight leaves no orphan job or stages", async () => {
  const f = fakeGeneration();
  f.db.$client.exec("insert into topics (id, title, mode, lang, minutes) values ('topic', 'Bees', 'standard', 'en', 1)");
  const beforeJobs = f.db.$client.prepare("select count(*) as n from jobs").get();
  const beforeStages = f.db.$client.prepare("select count(*) as n from job_stages").get();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, undefined, undefined, false, () => pending);
  try {
    const creating = runner.create({ topicId: "topic" });
    const result = expect(creating).rejects.toThrow("Topic not found");
    f.db.$client.exec("delete from topics where id = 'topic'");
    finish();
    await result;
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toEqual(beforeJobs);
    expect(f.db.$client.prepare("select count(*) as n from job_stages").get()).toEqual(beforeStages);
    expect(f.llm.stages).toEqual([]);
  } finally { finish(); await runner.close(); f.close(); }
});

test("topic assignment failure rolls back the job and stages", async () => {
  const f = fakeGeneration();
  f.db.$client.exec("insert into topics (id, title, mode, lang, minutes) values ('topic', 'Bees', 'standard', 'en', 1)");
  f.db.$client.exec("create trigger reject_assignment before update of topic_id on jobs begin select raise(abort, 'assignment failed'); end");
  const beforeJobs = f.db.$client.prepare("select count(*) as n from jobs").get();
  const beforeStages = f.db.$client.prepare("select count(*) as n from job_stages").get();
  const runner = createDesktopRunner(f.deps, new EventEmitter());
  try {
    await expect(runner.create({ topicId: "topic" })).rejects.toThrow("assignment failed");
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toEqual(beforeJobs);
    expect(f.db.$client.prepare("select count(*) as n from job_stages").get()).toEqual(beforeStages);
    expect(f.llm.stages).toEqual([]);
  } finally { await runner.close(); f.close(); }
});

test("prior unresolved work takes precedence over unreachable search without changing the marker", async () => {
  const f = fakeGeneration();
  const old = openDesktopGuard(f.dir);
  old.begin(); old.close(false);
  const preflight = vi.fn(async () => { throw new Error("SearXNG unreachable"); });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, undefined, undefined, false, preflight);
  try {
    await expect(runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 })).rejects.toThrow(/manual recovery/i);
    expect(preflight).not.toHaveBeenCalled();
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 1 });
    expect(f.llm.stages).toEqual([]);
  } finally { await runner.close(); }
  const marker = new Database(path.join(f.dir, "desktop-generation-state.sqlite"), { readonly: true });
  try { expect(marker.prepare("select count(*) as n from state").get()).toMatchObject({ n: 1 }); }
  finally { marker.close(); f.close(); }
});

test("both HTTP creation paths surface recovery before probing search", async () => {
  const f = fakeGeneration();
  f.db.$client.prepare("update jobs set status = 'failed' where id = ?").run(f.jobId);
  const old = openDesktopGuard(f.dir);
  old.begin(); old.close(false);
  const preflight = vi.fn(async () => { throw new Error("SearXNG unreachable"); });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, undefined, undefined, false, preflight);
  const app = buildApp({ db: f.db, runner });
  try {
    for (const request of [
      { url: "/api/jobs", payload: { title: "Bees", mode: "standard", lang: "en", minutes: 1 } },
      { url: `/api/jobs/${f.jobId}/retry-as-new`, payload: {} },
    ]) {
      const response = await app.inject({ method: "POST", ...request });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/manual recovery/i);
    }
    expect(preflight).not.toHaveBeenCalled();
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 1 });
  } finally { await app.close(); await runner.close(); f.close(); }
});

test.each(["resolve", "reject"] as const)("uncertain work while preflight is pending wins when preflight later %ss", async (outcome) => {
  const f = fakeGeneration();
  let releaseProvider!: () => void;
  let providerStarted!: () => void;
  let finishPreflight!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  const preflightGate = new Promise<void>((resolve) => { finishPreflight = resolve; });
  f.deps.providers.llm = { async generateObject() { providerStarted(); await providerGate; throw new Error("connection lost"); } };
  let calls = 0;
  const preflight = async () => {
    if (++calls === 1) return;
    await preflightGate;
    if (outcome === "reject") throw new Error("SearXNG unreachable");
  };
  const events = new EventEmitter();
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => { failed = resolve; });
  events.on("job-progress", (_id, progress) => { if (progress.kind === "job" && progress.status === "failed") failed(); });
  const runner = createDesktopRunner(f.deps, events, undefined, undefined, undefined, false, preflight);
  const request = { title: "Bees", brief: "", mode: "standard" as const, lang: "en", minutes: 1 };
  try {
    await runner.create(request);
    await started;
    const creating = runner.create(request);
    const result = expect(creating).rejects.toThrow(/manual recovery/i);
    releaseProvider();
    await failure;
    finishPreflight();
    await result;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 2 });
  } finally { releaseProvider(); finishPreflight(); await runner.close(); f.close(); }
});

test("a valid topic is assigned to a new queued job", async () => {
  const f = fakeGeneration();
  f.db.$client.exec("insert into topics (id, title, mode, lang, minutes) values ('topic', 'Bees', 'standard', 'en', 1)");
  const runner = createDesktopRunner(f.deps, new EventEmitter());
  try {
    const job = await runner.create({ topicId: "topic" });
    expect(job.topicId).toBe("topic");
    expect(f.db.$client.prepare("select topic_id from jobs where id = ?").get(job.id)).toMatchObject({ topic_id: "topic" });
    await runner.cancel(job.id);
    expect(f.llm.stages).toEqual([]);
  } finally { await runner.close(); f.close(); }
});

test("search failure before an active provider becomes uncertain does not queue another job", async () => {
  const f = fakeGeneration();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.deps.providers.llm = { async generateObject() { entered(); await gate; throw new Error("connection lost"); } };
  let calls = 0;
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, undefined, undefined, false, async () => {
    if (++calls > 1) throw new Error("SearXNG unreachable");
  });
  const request = { title: "Bees", brief: "", mode: "standard" as const, lang: "en", minutes: 1 };
  try {
    await runner.create(request);
    await started;
    await expect(runner.create(request)).rejects.toThrow("SearXNG unreachable");
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 2 });
    release();
    await vi.waitFor(() => expect(f.db.$client.prepare("select count(*) as n from jobs where status = 'failed'").get()).toMatchObject({ n: 1 }));
    await expect(runner.create(request)).rejects.toThrow(/manual recovery/i);
  } finally { release(); await runner.close(); f.close(); }
});
