import { safeGenerationError } from "../src/safe-generation-error.ts";
import { ChatGptCancelledError, ChatGptTimeoutError } from "../src/providers/llm/chatgpt-inference.ts";
import { ExternalWorkUncertain } from "../src/pipeline/runner.ts";
import { publicJobError } from "../src/job-log.ts";
import { describe, expect, test } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { AiSdkLlmProvider } from "../src/providers/llm/ai-sdk.ts";
import { TtsHttpError } from "../src/providers/tts/cache.ts";
import { AzureTtsProvider } from "../src/providers/tts/azure.ts";
import { OpenAiTtsProvider } from "../src/providers/tts/openai.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";
import { BraveSearchProvider } from "../src/providers/search/brave.ts";
import { TavilySearchProvider } from "../src/providers/search/tavily.ts";
import { SearxngSearchProvider } from "../src/providers/search/searxng.ts";

const secret = "synthetic-credential-for-boundary-test";

test.each([
  [new ChatGptTimeoutError(), "ChatGPT request timed out; remote work may still be running"],
  [new ChatGptCancelledError(), "ChatGPT request cancelled; remote work may still be running"],
  [new DOMException(secret, "TimeoutError"), "Generation timed out"],
  [new DOMException(secret, "AbortError"), "Generation cancelled"],
])("preserves safe classification through the external work wrapper", (error, message) => {
  for (const input of [error, new ExternalWorkUncertain(error)]) {
    expect(safeGenerationError(input)).toBe(message);
    expect(publicJobError(safeGenerationError(input))).toBe(message);
  }
});

test("unknown external errors disclose uncertainty without provider text", () => {
  const message = safeGenerationError(new ExternalWorkUncertain(new Error(secret)));
  expect(message).toBe("External work may still be running; stop the server and follow manual recovery in SETUP.md");
  expect(publicJobError(message)).toBe(message);
  expect(message).not.toContain(secret);
});

test("generation fallback retains safe timeout, cancellation, and diagnostics", () => {
  expect(safeGenerationError(new ChatGptTimeoutError())).toBe("ChatGPT request timed out; remote work may still be running");
  expect(safeGenerationError(new DOMException(secret, "TimeoutError"))).toBe("Generation timed out");
  expect(safeGenerationError(new DOMException(secret, "AbortError"))).toBe("Generation cancelled");
  expect(safeGenerationError(new Error("Monthly budget exceeded"))).toBe("Monthly budget exceeded");
  expect(safeGenerationError(new Error(secret))).toBe("Generation failed");
});

test("AI SDK invalid output does not disclose provider data", async () => {
  const response = { content: [{ type: "text" as const, text: secret }], finishReason: { unified: "stop" as const, raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
  const model = new MockLanguageModelV4({ modelId: "test", doGenerate: [response, response] });
  const provider = new AiSdkLlmProvider({ provider: "openai", models: { main: { id: "test", model }, fast: { id: "test", model } }, prices: "free" });
  const error = await provider.generateObject({ slot: "main", system: "test", prompt: "test", schema: z.object({ x: z.string() }) }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(secret);
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(secret);
});

test("AI SDK exceptions do not expose provider data", async () => {
  const model = new MockLanguageModelV4({ modelId: "test", doGenerate: async () => { throw new Error(secret); } });
  const provider = new AiSdkLlmProvider({ provider: "openai", models: { main: { id: "test", model }, fast: { id: "test", model } }, prices: "free" });
  const error = await provider.generateObject({ slot: "main", system: "test", prompt: "test", schema: z.object({ x: z.string() }) }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(secret);
});

describe.each(["azure", "openai"])("%s TTS exception boundary", (name) => {
  test.each(["http", "transport", "body", "typed"])("does not expose %s failures", async (failure) => {
    const dir = makeTempDir();
    try {
      const fetch = (async () => {
        if (failure === "typed") throw new TtsHttpError(401, secret);
        if (failure === "transport") throw new Error(secret);
        if (failure === "body") return { ok: true, arrayBuffer: async () => { throw new Error(secret); } } as unknown as Response;
        return new Response(secret, { status: 401, statusText: secret });
      }) as typeof globalThis.fetch;
      const options = { dataDir: dir, fetch, maxRetries: 0 };
      const provider = name === "azure"
        ? new AzureTtsProvider({ ...options, subscriptionKey: secret })
        : new OpenAiTtsProvider({ ...options, apiKey: secret });
      const error = await provider.synthesize({ text: "test", lang: "en", voice: "test", rate: 1 }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
    } finally {
      removeTempDir(dir);
    }
  });
});

test.each(["http", "transport", "body"])("SearXNG hides untrusted %s errors", async (failure) => {
  const fetch = (async () => {
    if (failure === "transport") throw new Error(secret);
    if (failure === "body") return new Response(secret, { status: 200 });
    return new Response(secret, { status: 503, statusText: secret });
  }) as typeof globalThis.fetch;
  const provider = new SearxngSearchProvider({ baseUrl: "http://127.0.0.1:8888", fetch });
  const error = await provider.search("query", { max: 1 }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(secret);
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(secret);
});

describe.each([
  ["Brave", (fetch: typeof globalThis.fetch) => new BraveSearchProvider({ apiKey: secret, fetch })],
  ["Tavily", (fetch: typeof globalThis.fetch) => new TavilySearchProvider({ apiKey: secret, fetch })],
])("%s search exception boundary", (_name, create) => {
  test.each(["http", "transport", "body"])("does not expose %s failures", async (failure) => {
    const fetch = (async () => {
      if (failure === "transport") throw new Error(secret);
      if (failure === "body") return new Response(secret, { status: 200 });
      return new Response(secret, { status: 401, statusText: secret });
    }) as typeof globalThis.fetch;
    const error = await create(fetch).search("query", { max: 1 }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
  });
});
