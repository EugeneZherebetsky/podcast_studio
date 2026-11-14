import { expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { createProviders, createFakeProviders } from "../src/providers/index.ts";
import { guardProviderResults } from "../src/providers/credential-echo.ts";
import { runPlanStage } from "../src/pipeline/plan.ts";
import { safeGenerationError } from "../src/safe-generation-error.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";
import { readdirSync } from "node:fs";

const canary = "synthetic+/credential-canary-834";

test("blocks a configured Google credential in a search result", async () => {
  const dir = makeTempDir();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", canary);
  try {
    const providers = createFakeProviders({ wavDir: dir });
    vi.spyOn(providers.search, "search").mockResolvedValue([{ title: canary, url: "https://example.com/", snippet: "normal" }] as never);
    const guarded = guardProviderResults(providers, parseConfig({ PROFILE: "local" }));
    await expect(guarded.search.search("test", { max: 1 })).rejects.toThrow("Provider output blocked: possible credential exposure");
  } finally { vi.unstubAllEnvs(); removeTempDir(dir); }
});
test.each([canary, encodeURIComponent(canary), Buffer.from(canary).toString("base64")])("rejects a known credential in a successful search result", async (echo) => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [{ title: echo, url: "https://example.com/", content: "normal" }] }), { status: 200 }));
  try {
    const providers = createProviders(parseConfig({ PROFILE: "local", OPENAI_API_KEY: canary, SEARXNG_URL: "http://localhost:8888" }));
    await expect(providers.search.search("test", { max: 1 })).rejects.toThrow("Provider output blocked: possible credential exposure");
  } finally { vi.unstubAllGlobals(); }
});

test("blocks credential-encoded search URLs before returning hits", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [{ title: "Safe", url: `https://example.com/?key=${encodeURIComponent(canary)}`, content: "normal" }] }), { status: 200 }));
  try {
    const providers = createProviders(parseConfig({ PROFILE: "local", OPENAI_API_KEY: canary, SEARXNG_URL: "http://localhost:8888" }));
    await expect(providers.search.search("test", { max: 1 })).rejects.toThrow("Provider output blocked: possible credential exposure");
  } finally { vi.unstubAllGlobals(); }
});

test("guards LLM objects before stage artifact writes and reports a fixed warning", async () => {
  const dir = makeTempDir();
  try {
    const providers = createFakeProviders({ wavDir: dir });
    vi.spyOn(providers.llm, "generateObject").mockResolvedValue({ object: { angle: canary } } as never);
    const guarded = guardProviderResults(providers, parseConfig({ PROFILE: "local", OPENAI_API_KEY: canary }));
    let error: unknown;
    try { await runPlanStage({ llm: guarded.llm, workDir: dir }, { title: "Bees", brief: "", lang: "en", mode: "standard", minutes: 5 }); } catch (caught) { error = caught; }
    expect(safeGenerationError(error)).toBe("Provider output blocked: possible credential exposure");
    expect(readdirSync(dir)).toEqual([]);
  } finally { removeTempDir(dir); }
});

test("guards extracted text and preserves normal results", async () => {
  const dir = makeTempDir();
  try {
    const providers = createFakeProviders({ wavDir: dir });
    const extract = vi.spyOn(providers.extractor, "extract");
    extract.mockResolvedValueOnce({ title: "Safe", site: "example.com", text: "Useful article" });
    extract.mockResolvedValueOnce({ title: "Safe", site: "example.com", text: encodeURIComponent(canary) });
    const guarded = guardProviderResults(providers, parseConfig({ PROFILE: "local", OPENAI_API_KEY: canary }));
    await expect(guarded.extractor.extract("https://example.com")).resolves.toMatchObject({ text: "Useful article" });
    await expect(guarded.extractor.extract("https://example.com")).rejects.toThrow("Provider output blocked: possible credential exposure");
  } finally { removeTempDir(dir); }
});
