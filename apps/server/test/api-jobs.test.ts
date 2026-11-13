import { expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { jobs } from "../src/db/schema.ts";

test("existing jobs are readable but job creation fails closed without a runner", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  try {
    const job = {
      id: "job",
      topicId: null,
      status: "failed",
      currentStage: "plan",
      error: "failed",
      options: { title: "News", brief: "", mode: "standard", lang: "en", minutes: 8 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    db.insert(jobs).values(job).run();
    expect((await app.inject({ url: "/api/jobs" })).json().jobs).toEqual([{ ...job, error: "Job failed." }]);
    expect((await app.inject({ url: "/api/jobs/job" })).json().stages).toEqual([]);
    expect(
      (await app.inject({ method: "POST", url: "/api/jobs", payload: job.options })).statusCode,
    ).toBe(503);
    expect((await app.inject({ method: "POST", url: "/api/jobs", payload: {} })).statusCode).toBe(
      400,
    );
  } finally {
    await app.close();
    db.$client.close();
  }
});

test("job control delegates to an injected runner", async () => {
  const db = openDatabase(":memory:");
  const job = {
    id: "job",
    topicId: null,
    status: "failed",
    currentStage: "plan",
    error: "failed",
    options: { title: "News", brief: "", mode: "standard", lang: "en", minutes: 8 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  db.insert(jobs).values(job).run();
  const runner = {
    create: vi.fn().mockResolvedValue(job),
    retry: vi.fn().mockResolvedValue(job),
    cancel: vi.fn().mockResolvedValue(job),
  };
  const app = buildApp({ db, runner });
  try {
    expect(
      (await app.inject({ method: "POST", url: "/api/jobs", payload: job.options })).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/jobs/job/retry",
          payload: { fromStage: "script" },
        })
      ).statusCode,
    ).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/jobs/job/cancel" })).statusCode).toBe(
      200,
    );
    expect(runner.retry).not.toHaveBeenCalled();
    expect(runner.cancel).toHaveBeenCalledWith("job");
  } finally {
    await app.close();
    db.$client.close();
  }
});


test("local learning jobs and retries fail closed unless explicitly enabled", async () => {
  for (const override of [false, true]) {
    const db = openDatabase(":memory:");
    const options = { title: "News", brief: "", mode: "graded", lang: "en", minutes: 8 } as const;
    const job = { id: "job", topicId: null, status: "failed", currentStage: "plan", error: "failed", options, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as const;
    db.insert(jobs).values(job).run();
    const runner = { create: vi.fn().mockResolvedValue(job), retry: vi.fn().mockResolvedValue(job), cancel: vi.fn() };
    const app = buildApp({ db, runner, config: parseConfig({ PROFILE: "local", ALLOW_LOCAL_LEARNING: override ? "1" : "0" }) });
    try {
      for (const mode of ["graded", "bilingual"]) {
        const res = await app.inject({ method: "POST", url: "/api/jobs", payload: { ...options, mode } });
        expect(res.statusCode).toBe(override ? 201 : 400);
      }
      expect((await app.inject({ method: "POST", url: "/api/jobs/job/retry", payload: {} })).statusCode).toBe(409);
      expect(runner.create).toHaveBeenCalledTimes(override ? 2 : 0);
      expect(runner.retry).not.toHaveBeenCalled();
      expect((await app.inject({ method: "POST", url: "/api/jobs", payload: { ...options, mode: "standard" } })).statusCode).toBe(201);
    } finally { await app.close(); db.$client.close(); }
  }
});


test("retry as new copies only failed job options through create", async () => {
  const db = openDatabase(":memory:");
  const old = { id: "old", topicId: null, status: "failed", currentStage: "notes", error: "failed", options: { title: "News", brief: "original", mode: "standard", lang: "en", minutes: 8 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as const;
  db.insert(jobs).values(old).run();
  const runner = { create: vi.fn().mockResolvedValue({ ...old, id: "new", status: "queued" }), retry: vi.fn(), cancel: vi.fn() };
  const app = buildApp({ db, runner });
  try {
    const response = await app.inject({ method: "POST", url: "/api/jobs/old/retry-as-new", payload: {} });
    expect(response.statusCode).toBe(201);
    expect(response.json().id).toBe("new");
    expect(runner.create).toHaveBeenCalledWith(old.options);
    expect(db.select().from(jobs).get()).toMatchObject(old);
    for (const status of ["succeeded", "running", "queued", "cancelled"] as const) {
      db.update(jobs).set({ status }).run();
      expect((await app.inject({ method: "POST", url: "/api/jobs/old/retry-as-new", payload: {} })).statusCode).toBe(409);
    }
    expect((await app.inject({ method: "POST", url: "/api/jobs/missing/retry-as-new", payload: {} })).statusCode).toBe(404);
    expect(runner.create).toHaveBeenCalledTimes(1);
  } finally { await app.close(); db.$client.close(); }
});
