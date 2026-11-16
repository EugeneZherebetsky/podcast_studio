// A synthetic key, delivered the way the desktop shell delivers it (the child environment
// built by the shell's own `childEnvironment`, parsed by `loadConfig`), is followed through the
// real dispatch path: HTTP job creation, the desktop runner, the pipeline, CloudTtsProvider and
// `paidRequest`. Only the transport is replaced, by a recorder standing in for the provider.
// Every sink the server writes is then searched for the key. No provider is contacted.
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { InjectOptions } from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { guardProviderResults } from "../src/providers/credential-echo.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";

const KEY = "synthetic-fake+cloud/speech-key-0001";
const NEEDLES = [KEY, encodeURIComponent(KEY), Buffer.from(KEY).toString("base64"), Buffer.from(KEY).toString("base64url")].map((needle) => needle.toLowerCase());
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
type ChildEnvironment = (parent: object, resources: string, home: string, tools: null, piper: null, services: null, keys?: Record<string, string>) => Record<string, string>;
const shell = (): Promise<{ childEnvironment: ChildEnvironment }> => import(new URL("../../desktop/supervisor.mjs", import.meta.url).href);

const PROVIDERS = {
  fish: { variable: "FISH_AUDIO_API_KEY", model: "s2.1-pro-free", url: "https://api.fish.audio/v1/tts", header: "authorization", value: `Bearer ${KEY}`, configured: "fishConfigured" },
  elevenlabs: { variable: "ELEVENLABS_API_KEY", model: "eleven_multilingual_v2", url: "https://api.elevenlabs.io/v1/text-to-speech/voice-id", header: "xi-api-key", value: KEY, configured: "elevenlabsConfigured" },
} as const;
type Scenario = "success" | "provider error" | "network error" | "timeout" | "cancellation";
const EXPECTED: Record<Scenario, { status: string; error: RegExp | null; calls: number }> = {
  "success": { status: "succeeded", error: null, calls: 6 },
  "provider error": { status: "failed", error: /^Cloud TTS failed; the provider may have billed this request$/, calls: 1 },
  "network error": { status: "failed", error: /^Cloud TTS failed; the provider may have billed this request; external work may still be running/, calls: 1 },
  "timeout": { status: "failed", error: /^Generation timed out; Cloud TTS failed; the provider may have billed this request; external work may still be running/, calls: 1 },
  "cancellation": { status: "cancelled", error: /^Generation cancelled; Cloud TTS failed; the provider may have billed this request; external work may still be running/, calls: 1 },
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? files(file) : [file];
  });
}
function expectClean(sinks: Record<string, string>): void {
  for (const [name, text] of Object.entries(sinks)) {
    const lower = text.toLowerCase();
    for (const needle of NEEDLES) expect(lower.includes(needle), `${name} contains the synthetic key`).toBe(false);
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

const cases = (Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).flatMap((provider) => (Object.keys(EXPECTED) as Scenario[]).map((scenario) => [provider, scenario] as const));

test.each(cases)("%s key stays out of every sink: %s", async (name, scenario) => {
  const provider = PROVIDERS[name];
  const f = fakeGeneration();
  const audio = await readFile((await f.providers.tts.synthesize({ text: "sample", lang: "en", voice: "fake", rate: 1 })).wavPath);
  const calls: { url: string; carried: boolean; redirect: unknown }[] = [];
  vi.stubGlobal("fetch", (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), carried: new Headers(init.headers).get(provider.header) === provider.value, redirect: init.redirect });
    // A hostile or careless provider: every reply and every failure repeats the key.
    const echo = { "x-echo": encodeURIComponent(KEY) };
    if (scenario === "success") return Promise.resolve(new Response(audio, { headers: echo }));
    if (scenario === "provider error") return Promise.resolve(new Response(JSON.stringify({ detail: `invalid api key ${KEY}` }), { status: 401, headers: echo }));
    if (scenario === "network error") return Promise.reject(new TypeError(`connect failed with header ${provider.value}`));
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException(`aborted ${KEY}`, "AbortError"))));
  });
  // The provider's own 120 s deadline, shortened for the timeout case only; nothing else changes.
  if (scenario === "timeout") vi.stubGlobal("setTimeout", (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => realSetTimeout(handler, ms === 120000 ? 300 : ms, ...args));

  const { childEnvironment } = await shell();
  const environment = childEnvironment({ [provider.variable]: "synthetic-parent-value" }, path.join(f.dir, "resources"), f.dir, null, null, null, { [provider.variable]: KEY });
  const config = loadConfig({ env: environment });
  expect(config[provider.variable]).toBe(KEY);
  const events = new EventEmitter();
  const emitted: unknown[] = [];
  events.on("event", (event) => emitted.push(event));
  events.on("job-progress", (...progress) => emitted.push(progress));
  const runner = createDesktopRunner({ ...f.deps, providers: guardProviderResults(f.deps.providers, config) }, events, config);
  const app = buildApp({ db: f.db, config, runner, events });
  const stream = new AbortController();
  let sse = "";
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const live = await realFetch(`${origin}/api/events`, { signal: stream.signal });
    const reading = (async () => { try { for await (const chunk of live.body as unknown as AsyncIterable<Uint8Array>) sse += Buffer.from(chunk).toString("latin1"); } catch { /* aborted below */ } })();
    const http: string[] = [];
    const call = async (options: InjectOptions) => {
      const response = await app.inject(options);
      http.push(JSON.stringify(response.headers) + response.body);
      return response;
    };
    expect((await call({ url: "/api/settings/cloud-tts" })).json()[provider.configured]).toBe(true);
    expect((await call({ method: "PUT", url: "/api/settings", payload: { cloudTts: { provider: name, model: provider.model, voice: "voice-id", inputLimit: 5000 } } })).statusCode).toBe(200);
    const created = await call({ method: "POST", url: "/api/jobs", payload: { title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    if (scenario === "cancellation") {
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 60000, interval: 50 });
      expect((await call({ method: "POST", url: `/api/jobs/${id}/cancel` })).statusCode).toBe(200);
    }
    await vi.waitFor(() => expect(runner.isBusy!(id)).toBe(false), { timeout: 90000, interval: 50 });
    const job = (await call({ url: `/api/jobs/${id}` })).json();
    for (const url of ["/api/jobs", `/api/jobs/${id}/log`, `/api/jobs/${id}/details`, "/api/settings", "/api/settings/cloud-tts", "/api/episodes", `/api/episodes/${id}`, "/api/health"]) await call({ url });
    await call({ method: "POST", url: "/api/jobs", payload: { title: "Again", brief: "", mode: "standard", lang: "en", minutes: 1, review: false } });

    const expected = EXPECTED[scenario];
    expect(job.status, String(job.error)).toBe(expected.status);
    if (expected.error) expect(job.error).toMatch(expected.error); else expect(job.error).toBeNull();
    // Fixed HTTPS endpoint, key in the provider's header, no redirects followed, no automatic retry.
    expect(calls).toHaveLength(expected.calls);
    for (const sent of calls) expect(sent).toEqual({ url: provider.url, carried: true, redirect: "error" });

    stream.abort();
    await reading;
    const tables = f.db.$client.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[];
    const rows = tables.map(({ name: table }) => [table, f.db.$client.prepare(`select * from "${table}"`).all()]);
    expect(sse).toContain("job-stage");
    expectClean({
      "SQLite rows": JSON.stringify(rows, (_key, value: unknown) => (Buffer.isBuffer(value) ? value.toString("latin1") : value)),
      "files and artifacts": files(f.dir).map((file) => `${file}\n${readFileSync(file, "latin1")}`).join("\n"),
      "events": JSON.stringify(emitted),
      "HTTP responses": http.join("\n"),
      "SSE stream": sse,
      "error text": JSON.stringify([job.error, job.stages]),
    });
    expect(files(f.dir).length).toBeGreaterThan(0);
  } finally {
    stream.abort();
    await app.close();
    await runner.close();
    f.close();
  }
}, GENERATION_TIMEOUT_MS);

test("without activation the same settings are refused before any request is sent", async () => {
  const f = fakeGeneration();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { childEnvironment } = await shell();
  const config = loadConfig({ env: childEnvironment({ FISH_AUDIO_API_KEY: "synthetic-parent-value" }, path.join(f.dir, "resources"), f.dir, null, null, null, undefined) });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), config);
  const app = buildApp({ db: f.db, config, runner });
  try {
    expect((await app.inject({ url: "/api/settings/cloud-tts" })).json().fishConfigured).toBe(false);
    await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: { provider: "fish", model: "s1", voice: "voice-id", inputLimit: 5000 } } });
    const refused = await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false } });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.body).toContain("Configure a valid cloud voice and provider key");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await app.close(); await runner.close(); f.close(); }
});
