import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { jobs } from "../src/db/schema.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("job logs survive app restart, filter jobs and never persist provider errors", async () => {
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  const config = parseConfig({ DATA_DIR: dir });
  const events = new EventEmitter();
  const job = {
    topicId: null,
    status: "failed",
    currentStage: "notes",
    error: null,
    options: { title: "Example", brief: "", mode: "standard", lang: "en", minutes: 8 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  for (const id of ["one", "two", "old"])
    db.insert(jobs)
      .values({ ...job, id })
      .run();
  let app = buildApp({ db, config, events });
  try {
    events.emit("job-progress", "one", { kind: "job", status: "started" });
    events.emit("event", { type: "job-stage", jobId: "one", stage: "notes", status: "running" });
    events.emit("job-progress", "one", {
      kind: "map",
      status: "done",
      index: 1,
      total: 2,
      elapsedMs: 42,
    });
    events.emit("event", {
      type: "job-stage",
      jobId: "one",
      stage: "notes",
      status: "failed",
      error: "private prompt SECRET C:\\private\\file",
    });
    events.emit("job-progress", "two", { kind: "job", status: "queued" });
    await app.close();
    app = buildApp({ db, config, events: new EventEmitter() });
    const one = (await app.inject({ url: "/api/jobs/one/log" })).json();
    expect(one.available).toBe(true);
    expect(one.entries.map((entry: { message: string }) => entry.message)).toEqual([
      "Job started",
      "notes running",
      "Map 1/2 completed (42 ms)",
      expect.stringMatching(/^notes failed \(\d+ ms\)$/),
    ]);
    expect(JSON.stringify(one)).not.toMatch(/SECRET|private|prompt/);
    expect((await app.inject({ url: "/api/jobs/two/log" })).json().entries).toHaveLength(1);
    expect((await app.inject({ url: "/api/jobs/old/log" })).json()).toEqual({
      available: false,
      entries: [],
    });
    expect((await app.inject({ url: "/api/jobs/missing/log" })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: "/api/jobs/one/log", remoteAddress: "192.0.2.1" })).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
    db.$client.close();
    removeTempDir(dir);
  }
});

test("log storage failure does not throw from progress event and reports unavailable", async () => {
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  const events = new EventEmitter();
  const config = parseConfig({ DATA_DIR: dir });
  const job = {
    id: "one",
    topicId: null,
    status: "queued",
    currentStage: null,
    error: null,
    options: { title: "Example", brief: "", mode: "standard", lang: "en", minutes: 8 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  db.insert(jobs).values(job).run();
  writeFileSync(path.join(dir, "job-logs"), "not a directory");
  const app = buildApp({ db, config, events });
  try {
    expect(() =>
      events.emit("job-progress", "one", { kind: "job", status: "started" }),
    ).not.toThrow();
    expect((await app.inject({ url: "/api/jobs/one/log" })).statusCode).toBe(503);
  } finally {
    await app.close();
    db.$client.close();
    removeTempDir(dir);
  }
});
