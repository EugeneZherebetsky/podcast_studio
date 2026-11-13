import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { episodes, jobs, jobStages, usage } from "../src/db/schema.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("real HTTP returns only a verified saved script and blocks cross-origin deletion", async () => {
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  const id = randomUUID(), owner = randomUUID();
  db.insert(jobs).values({ id, ownerToken: owner, status: "succeeded", options: { title: "Topic", brief: "Brief", mode: "standard", lang: "en", minutes: 8 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }).run();
  db.insert(jobStages).values({ jobId: id, stage: "script", status: "done", inputHash: "abc" }).run();
  const work = path.join(dir, "jobs", id, "runs", owner);
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "script.inputs.sha256"), "abc");
  writeFileSync(path.join(work, "script.json"), JSON.stringify({ title: "Title", summary: "Summary", chapters: [1, 2, 3].map((n) => ({ title: `Chapter ${n}`, segmentIndex: n })), segments: [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, kind: "content", speaker: "host", lang: "en", text: `Spoken ${n}` })), secret: "not returned" }));
  const app = buildApp({ db, config: parseConfig({ DATA_DIR: dir }) });
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${url}/api/jobs/${id}/details`);
    const body = await response.json() as { script: string };
    expect(body.script).toContain("Spoken 1");
    expect(JSON.stringify(body)).not.toContain("not returned");
    expect((await fetch(`${url}/api/jobs/${id}`, { method: "DELETE", headers: { origin: "http://evil.test" } })).status).toBe(403);
    writeFileSync(path.join(work, "script.inputs.sha256"), "different");
    expect((await (await fetch(`${url}/api/jobs/${id}/details`)).json() as { script: unknown }).script).toBeNull();
    expect((await fetch(`${url}/api/jobs/${id}`, { method: "DELETE", headers: { origin: url } })).status).toBe(200);
    expect((await fetch(`${url}/api/jobs/${id}`)).status).toBe(404);
  } finally { await app.close(); db.$client.close(); removeTempDir(dir); }
});

test("job details report unavailable script and no invented request metadata", async () => {
  const db = openDatabase(":memory:");
  db.insert(jobs).values({ id: "old", status: "failed", options: { title: "Topic", brief: "Brief", mode: "standard", lang: "en", minutes: 8 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }).run();
  const app = buildApp({ db });
  try {
    const result = await app.inject({ url: "/api/jobs/old/details" });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ script: null, providers: [], model: null });
  } finally { await app.close(); db.$client.close(); }
});

test("details use recorded request model rather than current settings", async () => {
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  db.insert(jobs).values({ id: "one", status: "failed", options: { title: "Topic", brief: "", mode: "standard", lang: "en", minutes: 8 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }).run();
  const events = new (await import("node:events")).EventEmitter();
  const app = buildApp({ db, config: parseConfig({ DATA_DIR: dir }), events });
  try {
    events.emit("job-progress", "one", { kind: "request", stage: "script", status: "sent", provider: "ollama", model: "qwen:4b", index: 1 });
    const result = (await app.inject({ url: "/api/jobs/one/details" })).json();
    expect(result.model).toBe("qwen:4b");
    expect(result.providers).toEqual(["ollama"]);
  } finally { await app.close(); db.$client.close(); removeTempDir(dir); }
});

test("terminal status cannot be deleted while its runner still owns it", async () => {
  const db = openDatabase(":memory:");
  db.insert(jobs).values({ id: "owned", status: "cancelled", options: { title: "Topic", brief: "", mode: "standard", lang: "en", minutes: 8 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }).run();
  const runner = { create: async () => { throw new Error("unused"); }, retry: async () => { throw new Error("unused"); }, cancel: async () => { throw new Error("unused"); }, isBusy: () => true };
  const app = buildApp({ db, runner });
  try {
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/owned" })).statusCode).toBe(409);
    expect(db.select().from(jobs).all()).toHaveLength(1);
  } finally { await app.close(); db.$client.close(); }
});

test("deleting a terminal job preserves its episode and usage and rejects active jobs", async () => {
  const db = openDatabase(":memory:");
  const job = { id: "job", status: "failed", options: { title: "Topic", brief: "Brief", mode: "standard", lang: "en", minutes: 8 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as const;
  db.insert(jobs).values(job).run();
  db.insert(jobStages).values({ jobId: "job", stage: "script", status: "running" }).run();
  db.insert(episodes).values({ id: "job", title: "Episode", summary: "Summary", mode: "standard", lang: "en", durationMs: 1, createdAt: job.createdAt, path: "kept" }).run();
  db.insert(usage).values({ ts: job.createdAt, provider: "test", kind: "llm", units: 1, costUsd: 1, jobId: "job" }).run();
  const app = buildApp({ db });
  try {
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/job" })).statusCode).toBe(409);
    db.update(jobStages).set({ status: "done" }).run();
    db.update(jobs).set({ status: "running" }).run();
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/job" })).statusCode).toBe(409);
    db.update(jobs).set({ status: "failed" }).run();
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/job", headers: { origin: "http://evil.test" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/job" })).statusCode).toBe(200);
    expect(db.select().from(episodes).all()).toHaveLength(1);
    expect(db.select().from(usage).get()?.jobId).toBeNull();
    expect(db.select().from(jobStages).all()).toHaveLength(0);
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/job" })).statusCode).toBe(404);
  } finally { await app.close(); db.$client.close(); }
});
