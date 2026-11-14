import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { AzureTtsProvider } from "../src/providers/tts/azure.ts";
import { OpenAiTtsProvider } from "../src/providers/tts/openai.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";

const payload = { title: "Bees", mode: "standard", lang: "en", minutes: 1, review: false };

test.each(["azure", "openai"] as const)("%s input limit preflight makes no paid request", async (name) => {
  const f = fakeGeneration();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
  const opts = { dataDir: f.dir, fetch: fetcher };
  const tts = name === "azure" ? new AzureTtsProvider({ ...opts, subscriptionKey: "test" }) : new OpenAiTtsProvider({ ...opts, apiKey: "test" });
  const runner = createDesktopRunner({ ...f.deps, cloudTtsInputLimit: 1, providers: { ...f.deps.providers, tts } }, new EventEmitter());
  const app = buildApp({ db: f.db, runner });
  try {
    const id = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/jobs/${id}` })).json().status).toBe("failed"), { timeout: 30000 });
    const job = (await app.inject({ url: `/api/jobs/${id}` })).json();
    expect(job.stages.find((stage: { stage: string }) => stage.stage === "tts").status).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await app.close(); await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);

test.each(["azure", "openai"] as const)("%s 503 blocks queued jobs and exposes the safe warning", async (name) => {
  const f = fakeGeneration();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async () => { await gate; return new Response("synthetic-secret", { status: 503 }); });
  const opts = { dataDir: f.dir, fetch: fetcher };
  const tts = name === "azure" ? new AzureTtsProvider({ ...opts, subscriptionKey: "test" }) : new OpenAiTtsProvider({ ...opts, apiKey: "test" });
  const events = new EventEmitter();
  const received: unknown[] = [];
  events.on("event", (event) => received.push(event));
  const runner = createDesktopRunner({ ...f.deps, providers: { ...f.deps.providers, tts } }, events);
  const app = buildApp({ db: f.db, runner, events });
  try {
    const first = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { timeout: 30000 });
    const second = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    release();
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/jobs/${second}` })).json().status).toBe("failed"));
    const job = (await app.inject({ url: `/api/jobs/${first}` })).json();
    const warning = "Cloud TTS failed; the provider may have billed this request; external work may still be running; stop the server and follow manual recovery in SETUP.md";
    expect(job.error).toBe(warning);
    expect(job.stages.find((stage: { stage: string }) => stage.stage === "tts").error).toBe(warning);
    expect(received).toContainEqual(expect.objectContaining({ type: "job-stage", stage: "tts", status: "failed", error: warning }));
    expect(JSON.stringify(job) + JSON.stringify(received)).not.toContain("synthetic-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const blocked = await app.inject({ method: "POST", url: "/api/jobs", payload });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain("manual recovery");
  } finally { release(); await app.close(); await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);

test.each(["azure", "openai"] as const)("%s cancellation after dispatch aborts once and retains billing warning", async (name) => {
  const f = fakeGeneration();
  const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("synthetic-secret", "AbortError")));
  }));
  const opts = { dataDir: f.dir, fetch: fetcher };
  const tts = name === "azure" ? new AzureTtsProvider({ ...opts, subscriptionKey: "test" }) : new OpenAiTtsProvider({ ...opts, apiKey: "test" });
  const runner = createDesktopRunner({ ...f.deps, providers: { ...f.deps.providers, tts } }, new EventEmitter());
  const app = buildApp({ db: f.db, runner });
  try {
    const id = (await app.inject({ method: "POST", url: "/api/jobs", payload })).json().id as string;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { timeout: 30000 });
    const cancelled = await app.inject({ method: "POST", url: `/api/jobs/${id}/cancel` });
    expect(cancelled.json().error).toContain("may have billed");
    await vi.waitFor(async () => {
      const job = (await app.inject({ url: `/api/jobs/${id}` })).json();
      expect(job.stages.find((stage: { stage: string }) => stage.stage === "tts").error).toContain("may have billed");
      expect(job.error).toContain("manual recovery");
      expect(JSON.stringify(job)).not.toContain("synthetic-secret");
    });
    await vi.waitFor(async () => expect((await app.inject({ method: "POST", url: "/api/jobs", payload })).statusCode).toBe(409));
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await app.close(); await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);
