import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";

test.each(["fish", "elevenlabs"] as const)("saved %s settings generate through the complete fake pipeline", async (provider) => {
  const f = fakeGeneration();
  const audio = await readFile((await f.providers.tts.synthesize({ text: "sample", lang: "en", voice: "fake", rate: 1 })).wavPath);
  const fetcher = vi.fn(async () => new Response(audio));
  vi.stubGlobal("fetch", fetcher);
  const config = parseConfig({ PROFILE: "local", FISH_AUDIO_API_KEY: "test-key", ELEVENLABS_API_KEY: "test-key" });
  const events = new EventEmitter();
  const runner = createDesktopRunner(f.deps, events, config);
  const app = buildApp({ db: f.db, config, runner, events });
  try {
    const saved = await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: { provider, model: provider === "fish" ? "s2.1-pro-free" : "eleven_multilingual_v2", voice: "voice-id", inputLimit: 5000 } } });
    expect(saved.statusCode).toBe(200);
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false } });
    expect(response.statusCode).toBe(201);
    const id = response.json().id as string;
    await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: null } });
    await vi.waitFor(async () => {
      const job = (await app.inject({ url: `/api/jobs/${id}` })).json();
      expect(job.status, job.error).toBe("succeeded");
    }, { timeout: 30000, interval: 100 });
    expect(fetcher).toHaveBeenCalledTimes(6);
  } finally { await app.close(); await runner.close(); vi.unstubAllGlobals(); f.close(); }
}, GENERATION_TIMEOUT_MS);

test("uncertain cloud failure retains the desktop recovery guard", async () => {
  const f = fakeGeneration();
  const fetcher = vi.fn(async () => new Response("provider error", { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const config = parseConfig({ PROFILE: "local", FISH_AUDIO_API_KEY: "test-key" });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), config);
  const app = buildApp({ db: f.db, config, runner });
  try {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: { provider: "fish", model: "s2.1-pro-free", voice: "voice-id", inputLimit: 5000 } } });
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Bees", mode: "standard", lang: "en", minutes: 1, review: false } });
    const id = response.json().id as string;
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/jobs/${id}` })).json().status).toBe("failed"), { timeout: 30000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(runner.create({ title: "Again", brief: "", mode: "standard", lang: "en", minutes: 1 })).rejects.toThrow("External work may still be running");
  } finally { await app.close(); await runner.close(); vi.unstubAllGlobals(); f.close(); }
}, GENERATION_TIMEOUT_MS);


test("malformed provider WAV stops before a second paid request", async () => {
  const f = fakeGeneration();
  const audio = await readFile((await f.providers.tts.synthesize({ text: "sample", lang: "en", voice: "fake", rate: 1 })).wavPath);
  audio.writeUInt32LE(audio.length + 100, 40);
  const fetcher = vi.fn(async () => new Response(audio));
  vi.stubGlobal("fetch", fetcher);
  const config = parseConfig({ PROFILE: "local", FISH_AUDIO_API_KEY: "test-key" });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), config);
  const app = buildApp({ db: f.db, config, runner });
  try {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: { provider: "fish", model: "s2.1-pro-free", voice: "voice-id", inputLimit: 5000 } } });
    const id = (await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Bees", mode: "standard", lang: "en", minutes: 1, review: false } })).json().id as string;
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/jobs/${id}` })).json().status).toBe("failed"), { timeout: 30000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await app.close(); await runner.close(); vi.unstubAllGlobals(); f.close(); }
}, GENERATION_TIMEOUT_MS);

test("cancellation during cloud request exposes billing uncertainty and retains guard", async () => {
  const f = fakeGeneration();
  const fetcher = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
  vi.stubGlobal("fetch", fetcher);
  const config = parseConfig({ PROFILE: "local", FISH_AUDIO_API_KEY: "test-key" });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), config);
  const app = buildApp({ db: f.db, config, runner });
  try {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: { provider: "fish", model: "s2.1-pro-free", voice: "voice-id", inputLimit: 5000 } } });
    const id = (await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Bees", mode: "standard", lang: "en", minutes: 1, review: false } })).json().id as string;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { timeout: 30000 });
    const cancelled = (await app.inject({ method: "POST", url: `/api/jobs/${id}/cancel` })).json();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toContain("may have billed");
    await vi.waitFor(async () => expect((await app.inject({ url: `/api/jobs/${id}` })).json().error).toContain("may have billed"));
    await vi.waitFor(async () => await expect(runner.create({ title: "Again", brief: "", mode: "standard", lang: "en", minutes: 1 })).rejects.toThrow("External work may still be running"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await app.close(); await runner.close(); vi.unstubAllGlobals(); f.close(); }
}, GENERATION_TIMEOUT_MS);
