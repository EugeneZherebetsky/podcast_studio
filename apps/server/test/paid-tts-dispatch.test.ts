import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { expect, test, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { OpenAiTtsProvider } from "../src/providers/tts/openai.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";
import { recordLlmUsage } from "../src/usage.ts";
import { jobs } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { openDesktopGuard } from "../src/desktop-guard.ts";

const payload = { title: "Bees", mode: "standard", lang: "en", minutes: 1, review: false };

test("cancelling in the limiter does not imply dispatch or block the next job", async () => {
  const f = fakeGeneration();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async () => new Response("synthetic-secret", { status: 400 }));
  const tts = new OpenAiTtsProvider({ apiKey: "synthetic-key", dataDir: f.dir, fetch: fetcher, concurrencyLimit: 1 });
  tts.forRun = () => tts;
  const holder = tts.cache.limiter.run(() => gate);
  const runner = createDesktopRunner({ ...f.deps, providers: { ...f.deps.providers, tts } }, new EventEmitter());
  const app = buildApp({ db: f.db, runner });
  try {
    const first = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    await vi.waitFor(() => expect(tts.cache.limiter.pendingCount).toBe(1), { timeout: 30000 });
    const second = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    const cancelled = await app.inject({ method: "POST", url: `/api/jobs/${first}/cancel` });
    expect(cancelled.json().error ?? "").not.toContain("bill");
    expect(fetcher).not.toHaveBeenCalled();
    release();
    await holder;
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/jobs/${second}` })).json().status).toBe("failed"), { timeout: 30000 });
    const firstJob = (await app.inject({ url: `/api/jobs/${first}` })).json();
    expect(firstJob.status).toBe("cancelled");
    expect(firstJob.error ?? "").not.toContain("bill");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "POST", url: "/api/jobs", payload })).statusCode).toBe(201);
  } finally { release(); await holder; await app.close(); await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);

test("budget rejection after limiter wait does not mark external work uncertain", async () => {
  const f = fakeGeneration();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 400 }));
  const tts = new OpenAiTtsProvider({ apiKey: "synthetic-key", dataDir: f.dir, fetch: fetcher, concurrencyLimit: 1 });
  tts.forRun = () => tts;
  const holder = tts.cache.limiter.run(() => gate);
  const runner = createDesktopRunner({ ...f.deps, providers: { ...f.deps.providers, tts } }, new EventEmitter());
  const app = buildApp({ db: f.db, runner });
  try {
    const first = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    await vi.waitFor(() => expect(tts.cache.limiter.pendingCount).toBe(1), { timeout: 30000 });
    const second = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    recordLlmUsage(f.db, { provider: "unknown", model: "unknown", inputTokens: 0, outputTokens: 0, costUsd: Infinity });
    release();
    await holder;
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/jobs/${second}` })).json().status).toBe("failed"), { timeout: 30000 });
    expect(f.db.select().from(jobs).where(eq(jobs.id, first)).get()?.error).toBe("Invalid recorded spending");
    expect(f.db.select().from(jobs).where(eq(jobs.id, second)).get()?.error).toBe("Invalid recorded spending");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { release(); await holder; await app.close(); await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);

test("local server stalled after dispatch hits deadline and blocks queued jobs", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local server address");
  const f = fakeGeneration();
  let calls = 0;
  const fetcher: typeof fetch = (...args) => { calls++; return fetch(...args); };
  const tts = new OpenAiTtsProvider({ apiKey: "synthetic-key", dataDir: f.dir, baseUrl: `http://127.0.0.1:${address.port}`, fetch: fetcher, timeoutMs: 300 });
  const runner = createDesktopRunner({ ...f.deps, providers: { ...f.deps.providers, tts } }, new EventEmitter());
  const app = buildApp({ db: f.db, runner });
  try {
    const first = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 30000 });
    const second = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/jobs/${second}` })).json().status).toBe("failed"), { timeout: 5000 });
    const job = (await app.inject({ url: `/api/jobs/${first}` })).json();
    expect(job.error).toContain("may have billed");
    expect(job.error).toContain("manual recovery");
    expect(JSON.stringify(job)).not.toContain("synthetic-key");
    expect(calls).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/jobs", payload })).statusCode).toBe(409);
    expect(await runner.close()).toBe(true);
    const guard = openDesktopGuard(f.dir);
    try { expect(() => guard.begin()).toThrow("Unclean desktop generation is unresolved"); }
    finally { guard.close(false); }
  } finally { await app.close(); await runner.close(); f.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}, GENERATION_TIMEOUT_MS);
