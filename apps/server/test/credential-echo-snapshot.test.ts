import { expect, test } from "vitest";
import { parseConfig } from "shared";
import { createFakeProviders, type Providers } from "../src/providers/index.ts";
import { guardProviderResults } from "../src/providers/credential-echo.ts";
import type { LlmProvider } from "../src/providers/llm/interface.ts";
import { PlanSchema } from "../src/pipeline/schemas.ts";
import { checkBudget, generateJob } from "../src/pipeline/runner.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

const canary = "synthetic+/credential-canary-512";
const BLOCKED = "Provider output blocked: possible credential exposure";
const config = parseConfig({ PROFILE: "local", FISH_AUDIO_API_KEY: canary });
const request = { slot: "fast" as const, system: "s", prompt: "p", schema: PlanSchema };

/** Reads as harmless while it is scanned and as the credential on every later read. */
function shifting(safe: string): { reads: number; value: string } {
  let reads = 0;
  return { get reads() { return reads; }, get value() { return reads++ === 0 ? safe : canary; } } as { reads: number; value: string };
}

function guarded(overrides: Partial<Providers>): Providers {
  const dir = makeTempDir();
  try { return guardProviderResults({ ...createFakeProviders({ wavDir: dir }), ...overrides }, config); }
  finally { removeTempDir(dir); }
}

test("a getter that changes after the scan cannot deliver the credential: results are plain snapshots", async () => {
  const text = shifting("Useful article");
  const page = { title: "Safe", site: "example.com", get text() { return text.value; } };
  const title = shifting("Hit");
  const hit = { url: "https://example.com/", snippet: "normal", get title() { return title.value; } };
  const angle = shifting("Bees");
  const object = { queries: ["one"], get angle() { return angle.value; } };
  const providers = guarded({
    extractor: { extract: async () => page },
    search: { search: async () => [hit] },
    llm: { generateObject: async () => ({ object }) } as unknown as LlmProvider,
  });

  const extracted = (await providers.extractor.extract("https://example.com"))!;
  const hits = await providers.search.search("q", { max: 1 });
  const generated = await providers.llm.generateObject(request);

  expect(extracted).not.toBe(page);
  expect(hits[0]).not.toBe(hit);
  expect(generated.object).not.toBe(object);
  for (let read = 0; read < 3; read++) {
    expect(extracted.text).toBe("Useful article");
    expect(hits[0]!.title).toBe("Hit");
    expect((generated.object as { angle: string }).angle).toBe("Bees");
  }
  expect(Object.getOwnPropertyDescriptor(extracted, "text")).toMatchObject({ value: "Useful article" });
  expect(JSON.stringify([extracted, hits, generated])).not.toContain(canary);
  // Proof the fixture works: the originals now read as the credential.
  expect(page.text + hit.title + object.angle).toContain(canary);
});

test("results that cannot be snapshotted as plain data are blocked", async () => {
  class Page { title = "Safe"; site = "example.com"; text = "Useful article"; }
  const cyclic: Record<string, unknown> = { title: "Safe", site: "example.com", text: "Useful" };
  cyclic.self = cyclic;
  for (const value of [new Page(), cyclic, { title: "Safe", site: "example.com", text: "x", render: () => canary }, { title: "Safe", site: "example.com", text: "x", when: new Date(0) }]) {
    const providers = guarded({ extractor: { extract: async () => value as never } });
    await expect(providers.extractor.extract("https://example.com")).rejects.toThrow(BLOCKED);
  }
  const providers = guarded({ extractor: { extract: async () => null } });
  await expect(providers.extractor.extract("https://example.com")).resolves.toBeNull();
});

test("a blocked paid LLM result keeps its valid usage, sanitized", async () => {
  const usage = { provider: "anthropic", model: `model-${canary}`, inputTokens: 100, outputTokens: 20, costUsd: 0.25 };
  const providers = guarded({ llm: { generateObject: async () => ({ object: { angle: canary }, usage }) } as unknown as LlmProvider });
  const error = await providers.llm.generateObject(request).catch((caught: unknown) => caught) as Error & { usage?: unknown };
  expect(error.message).toBe(BLOCKED);
  expect(error.usage).toEqual({ provider: "anthropic", model: "unknown", inputTokens: 100, outputTokens: 20, costUsd: 0.25 });
  expect(JSON.stringify(error.usage)).not.toContain(canary);
});

test("a blocked result without usage carries none, and unreadable usage is marked uncertain", async () => {
  const free = guarded({ llm: { generateObject: async () => ({ object: { angle: canary } }) } as unknown as LlmProvider });
  const freeError = await free.llm.generateObject(request).catch((caught: unknown) => caught) as Error;
  expect(freeError.message).toBe(BLOCKED);
  expect("usage" in freeError).toBe(false);
  const broken = [
    { provider: "anthropic", model: "m", inputTokens: 1, outputTokens: 1, costUsd: Number.NaN },
    { provider: "anthropic", model: "m", inputTokens: -1, outputTokens: 1, costUsd: 1 },
    { get provider(): string { throw new Error(canary); }, model: "m", inputTokens: 1, outputTokens: 1, costUsd: 1 },
    "not an object",
  ];
  for (const usage of broken) {
    const providers = guarded({ llm: { generateObject: async () => ({ object: { angle: canary }, usage }) } as unknown as LlmProvider });
    const error = await providers.llm.generateObject(request).catch((caught: unknown) => caught) as Error & { usage?: unknown };
    expect(error.message).toBe(BLOCKED);
    expect("usage" in error).toBe(true);
    expect(error.usage).toBeUndefined();
  }
});

test.each([
  ["valid cost is recorded for the job", { provider: "anthropic", model: "m", inputTokens: 100, outputTokens: 20, costUsd: 0.25 }, 0.25],
  ["uncertain spend blocks the budget until reconciled", { provider: "anthropic", model: "m", inputTokens: 100, outputTokens: 20, costUsd: "0.25" }, Infinity],
])("through the runner, a blocked paid result: %s", async (_name, usage, expected) => {
  const f = fakeGeneration();
  try {
    const llm = { generateObject: async () => ({ object: { queries: ["one", "two", "three", "four", "five"], angle: canary }, usage }) } as unknown as LlmProvider;
    const providers = guardProviderResults({ ...f.deps.providers, llm }, config);
    await expect(generateJob({ ...f.deps, providers }, f.jobId)).rejects.toThrow();
    const rows = f.db.$client.prepare("select provider, kind, units, cost_usd as costUsd, job_id as jobId from usage").all();
    expect(rows).toEqual([{ provider: expected === Infinity ? "unknown" : "anthropic", kind: "llm", units: expected === Infinity ? 0 : 120, costUsd: expected, jobId: f.jobId }]);
    expect(JSON.stringify(rows) + JSON.stringify(f.job())).not.toContain(canary);
    if (expected === Infinity) expect(() => checkBudget(f.db, 20)).toThrow("Invalid recorded spending");
    else expect(() => checkBudget(f.db, 20)).not.toThrow();
  } finally { f.close(); }
}, GENERATION_TIMEOUT_MS);
