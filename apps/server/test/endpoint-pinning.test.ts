import { afterEach, expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { z } from "zod";
import { createSearchProvider, createTtsProvider, AzureTtsProvider } from "../src/providers/index.ts";
import { createAiSdkLlmProvider } from "../src/providers/llm/ai-sdk.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

// Obviously fake: no real provider is contacted; `fetch` is replaced by a recorder.
const KEY = "synthetic-endpoint-test-key-0001";
const REDIRECT = "https://redirect.invalid/v1";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function recordFetch(status = 400): { urls: URL[]; carried: boolean[] } {
  const seen = { urls: [] as URL[], carried: [] as boolean[] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    seen.urls.push(new URL(request ? request.url : String(input)));
    const headers = JSON.stringify([...new Headers(request?.headers ?? init?.headers).entries()]);
    seen.carried.push((headers + String(init?.body ?? "")).includes(KEY));
    return new Response(JSON.stringify({ error: { message: "synthetic refusal" } }), { status, headers: { "content-type": "application/json" } });
  });
  return seen;
}

test.each([
  ["anthropic", "ANTHROPIC_API_KEY", "https://api.anthropic.com"],
  ["openai", "OPENAI_API_KEY", "https://api.openai.com"],
  ["google", "GOOGLE_GENERATIVE_AI_API_KEY", "https://generativelanguage.googleapis.com"],
] as const)("%s LLM requests ignore base-URL environment overrides", async (name, variable, origin) => {
  for (const override of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GOOGLE_GENERATIVE_AI_BASE_URL", "GOOGLE_BASE_URL", "OPENAI_API_BASE"]) vi.stubEnv(override, REDIRECT);
  const seen = recordFetch();
  const config = parseConfig({ PROFILE: "cloud", LLM_PROVIDER: name, LLM_MODEL_MAIN: "synthetic-model", LLM_MODEL_FAST: "synthetic-model", [variable]: KEY });
  const provider = createAiSdkLlmProvider(config, name, { env: { [variable]: KEY }, prices: { "synthetic-model": { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } } });
  const error = await provider.generateObject({ slot: "main", system: "s", prompt: "p", schema: z.object({ a: z.string() }), assertContinue: () => {} }).catch((caught: unknown) => caught) as Error;
  expect(error.message).toBe("LLM request failed");
  expect(seen.urls.length).toBe(1);
  expect(seen.urls[0]!.origin).toBe(origin);
  expect(seen.carried).toEqual([true]);
});

test.each(["redirect.invalid/#", "redirect.invalid", "west europe", "westeurope.attacker", "WESTEUROPE", "", "a".repeat(41), "west-europe@x"])("Azure Speech refuses region %j, which would otherwise form the request host", (region) => {
  const dir = makeTempDir();
  try {
    expect(() => new AzureTtsProvider({ subscriptionKey: KEY, region, dataDir: dir })).toThrow("Invalid Azure Speech region");
    if (region.trim()) expect(() => createTtsProvider(parseConfig({ PROFILE: "cloud", TTS_PROVIDER: "azure", AZURE_SPEECH_KEY: KEY, AZURE_SPEECH_REGION: region, DATA_DIR: dir }))).toThrow("Invalid Azure Speech region");
  } finally { removeTempDir(dir); }
});

test("Azure Speech sends its key only to the validated regional Microsoft host", async () => {
  const dir = makeTempDir();
  const seen = recordFetch();
  try {
    const tts = createTtsProvider(parseConfig({ PROFILE: "cloud", TTS_PROVIDER: "azure", AZURE_SPEECH_KEY: KEY, AZURE_SPEECH_REGION: "eastus2", DATA_DIR: dir })).forRun!(dir);
    await expect(tts.synthesize({ text: "hello", lang: "en", voice: "en-US-JennyNeural", rate: 1 })).rejects.toThrow();
    expect(seen.urls.map((url) => url.origin)).toEqual(["https://eastus2.tts.speech.microsoft.com"]);
    expect(seen.carried).toEqual([true]);
  } finally { removeTempDir(dir); }
});

test("search and OpenAI speech built from configuration use only their built-in hosts", async () => {
  const dir = makeTempDir();
  for (const override of ["OPENAI_BASE_URL", "TAVILY_BASE_URL", "BRAVE_BASE_URL", "TAVILY_API_URL"]) vi.stubEnv(override, REDIRECT);
  const overrides = { OPENAI_BASE_URL: REDIRECT, TAVILY_BASE_URL: REDIRECT, BRAVE_BASE_URL: REDIRECT, baseUrl: REDIRECT };
  const seen = recordFetch();
  try {
    await expect(createSearchProvider(parseConfig({ ...overrides, PROFILE: "cloud", SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: KEY })).search("q", { max: 1 })).rejects.toThrow();
    await expect(createSearchProvider(parseConfig({ ...overrides, PROFILE: "cloud", SEARCH_PROVIDER: "brave", BRAVE_API_KEY: KEY })).search("q", { max: 1 })).rejects.toThrow();
    const tts = createTtsProvider(parseConfig({ ...overrides, PROFILE: "cloud", TTS_PROVIDER: "openai", OPENAI_API_KEY: KEY, DATA_DIR: dir })).forRun!(dir);
    await expect(tts.synthesize({ text: "hello", lang: "en", voice: "alloy", rate: 1 })).rejects.toThrow();
    expect(seen.urls.map((url) => url.origin)).toEqual(["https://api.tavily.com", "https://api.search.brave.com", "https://api.openai.com"]);
    expect(seen.carried).toEqual([true, true, true]);
  } finally { removeTempDir(dir); }
});
