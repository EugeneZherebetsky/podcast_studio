import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { CancelledAfterStage } from "../src/pipeline/cancellation.ts";
import { describe, expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { z } from "zod";
import { computeLlmCostUsd, type LlmPriceTable } from "../src/config.ts";
import { createLlmProvider } from "../src/providers/index.ts";
import {
  AiSdkLlmProvider,
  createAiSdkLlmProvider,
  LlmOutputError,
} from "../src/providers/llm/ai-sdk.ts";

const CitySchema = z.object({ city: z.string(), population: z.number().int() });

const VALID = JSON.stringify({ city: "Budapest", population: 1700000 });
const WRONG_SHAPE = JSON.stringify({ city: "Budapest", population: "many" });

/** One scripted model response, in the shape the AI SDK's mock model expects. */
function reply(text: string, inputTokens = 100, outputTokens = 20) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: {
        total: inputTokens,
        noCache: inputTokens,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
    },
    warnings: [],
  };
}

const PRICES: LlmPriceTable = {
  "model-main": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "model-fast": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
};

function setup(options: { main?: string[]; fast?: string[]; prices?: LlmPriceTable } = {}) {
  const main = new MockLanguageModelV4({
    modelId: "model-main",
    doGenerate: (options.main ?? [VALID]).map((text) => reply(text)),
  });
  const fast = new MockLanguageModelV4({
    modelId: "model-fast",
    doGenerate: (options.fast ?? [VALID]).map((text) => reply(text)),
  });
  const warnings: string[] = [];
  const provider = new AiSdkLlmProvider({
    provider: "anthropic",
    models: {
      main: { id: "model-main", model: main },
      fast: { id: "model-fast", model: fast },
    },
    prices: options.prices ?? PRICES,
    warn: (message) => warnings.push(message),
  });
  return { provider, main, fast, warnings };
}

const request = { system: "Be terse.", prompt: "Name a city.", schema: CitySchema };

describe("AiSdkLlmProvider.generateObject", () => {
  test.each(["ollama", "anthropic"])("%s does not retry a transient failure after cancellation", async (name) => {
    let cancelled = false;
    const model = new MockLanguageModelV4({ modelId: "test", doGenerate: async () => {
      if (cancelled) return reply(VALID);
      cancelled = true;
      throw new APICallError({ message: "connection lost", url: "http://example.invalid", requestBodyValues: {}, isRetryable: true });
    } });
    const provider = new AiSdkLlmProvider({ provider: name, models: { main: { id: "test", model }, fast: { id: "test", model } }, prices: "free" });
    const result = provider.generateObject({ slot: "main", ...request, assertContinue: () => { if (cancelled) throw new CancelledAfterStage("cancelled"); } });
    await expect(result).rejects.not.toBeInstanceOf(CancelledAfterStage);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("cancellation stops the invalid-output retry", async () => {
    const { provider, main } = setup({ main: [WRONG_SHAPE, VALID] });
    await expect(provider.generateObject({ slot: "main", ...request, assertContinue: () => { throw new CancelledAfterStage("cancelled"); } })).rejects.toBeInstanceOf(CancelledAfterStage);
    expect(main.doGenerateCalls).toHaveLength(1);
  });
  test("returns the validated object with usage and cost", async () => {
    const { provider, main, warnings } = setup();

    const result = await provider.generateObject({ slot: "main", ...request });

    expect(result.object).toEqual({ city: "Budapest", population: 1700000 });
    expect(result.usage).toEqual({
      provider: "anthropic",
      model: "model-main",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: (100 * 3 + 20 * 15) / 1_000_000,
    });
    expect(main.doGenerateCalls).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("sends the system text, the prompt and the JSON schema to the model, with no tools", async () => {
    const { provider, main } = setup();
    await provider.generateObject({ slot: "main", ...request });

    const call = main.doGenerateCalls[0]!;
    expect(JSON.stringify(call.prompt)).toContain("Be terse.");
    expect(JSON.stringify(call.prompt)).toContain("Name a city.");
    expect(call.responseFormat).toMatchObject({ type: "json" });
    expect(JSON.stringify(call.responseFormat)).toContain("population");
    expect(call.tools ?? []).toEqual([]);
  });

  test("the slot selects the model", async () => {
    const { provider, main, fast } = setup();

    const result = await provider.generateObject({ slot: "fast", ...request });

    expect(result.usage.model).toBe("model-fast");
    expect(result.usage.costUsd).toBeCloseTo((100 * 1 + 20 * 5) / 1_000_000, 12);
    expect(fast.doGenerateCalls).toHaveLength(1);
    expect(main.doGenerateCalls).toHaveLength(0);
  });

  test("retries once after an invalid response and adds up the usage of both calls", async () => {
    const { provider, main } = setup({ main: [WRONG_SHAPE, VALID] });

    const result = await provider.generateObject({ slot: "main", ...request });

    expect(result.object).toEqual({ city: "Budapest", population: 1700000 });
    expect(main.doGenerateCalls).toHaveLength(2);
    expect(main.doGenerateCalls[1]!.prompt).toEqual(main.doGenerateCalls[0]!.prompt);
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(40);
    expect(result.usage.costUsd).toBeCloseTo((200 * 3 + 40 * 15) / 1_000_000, 12);
  });

  test("retries once when the response is not JSON at all", async () => {
    const { provider, main } = setup({ main: ["Sure! Here is a city.", VALID] });
    const result = await provider.generateObject({ slot: "main", ...request });
    expect(result.object.city).toBe("Budapest");
    expect(main.doGenerateCalls).toHaveLength(2);
  });

  test("two invalid responses throw a readable error after exactly two calls", async () => {
    const { provider, main } = setup({ main: [WRONG_SHAPE, WRONG_SHAPE, VALID] });

    const error = await provider.generateObject({ slot: "main", ...request }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(main.doGenerateCalls).toHaveLength(2);
    expect(error).toBeInstanceOf(LlmOutputError);
    const outputError = error as LlmOutputError;
    expect(outputError.message).toContain("anthropic/model-main");
    expect(outputError.message).toContain('slot "main"');
    expect(outputError.message).toContain("2 attempts");
    // formatZodError: the path of the offending field and what was wrong with it.
    expect(outputError.message).toContain("population: Invalid input: expected number");
    // The failed calls were still billed.
    expect(outputError.usage).toMatchObject({ inputTokens: 200, outputTokens: 40 });
    expect(outputError.usage.costUsd).toBeCloseTo((200 * 3 + 40 * 15) / 1_000_000, 12);
  });

  test("a non-JSON response is reported as such, with a short excerpt", async () => {
    const { provider } = setup({ main: ["I cannot do that.", "I cannot do that."] });
    await expect(provider.generateObject({ slot: "main", ...request })).rejects.toThrowError(
      /not valid JSON.*I cannot do that\./s,
    );
  });

  test("an unknown model costs 0 and warns once", async () => {
    const { provider, warnings } = setup({ main: [VALID, VALID], prices: {} });

    const first = await provider.generateObject({ slot: "main", ...request });
    await provider.generateObject({ slot: "main", ...request });

    expect(first.usage.costUsd).toBe(0);
    expect(first.usage.inputTokens).toBe(100);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("model-main");
  });

  test("errors that are not about the output (e.g. the API is down) are not retried here", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      modelId: "model-main",
      doGenerate: async () => {
        calls += 1;
        throw new Error("connection refused");
      },
    });
    const provider = new AiSdkLlmProvider({
      provider: "ollama",
      models: { main: { id: "model-main", model }, fast: { id: "model-main", model } },
      prices: "free",
    });
    await expect(provider.generateObject({ slot: "main", ...request })).rejects.toThrowError(
      "connection refused",
    );
    expect(calls).toBe(1);
  });

  test("a free provider reports cost 0 without a warning", async () => {
    const model = new MockLanguageModelV4({ modelId: "tiny", doGenerate: reply(VALID) });
    const warnings: string[] = [];
    const provider = new AiSdkLlmProvider({
      provider: "ollama",
      models: { main: { id: "tiny", model }, fast: { id: "tiny", model } },
      prices: "free",
      warn: (message) => warnings.push(message),
    });
    const { usage } = await provider.generateObject({ slot: "fast", ...request });
    expect(usage).toEqual({
      provider: "ollama",
      model: "tiny",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0,
    });
    expect(warnings).toEqual([]);
  });
});

describe("computeLlmCostUsd", () => {
  test("multiplies tokens by the per-million prices", () => {
    expect(computeLlmCostUsd(PRICES, "model-main", 1_000_000, 500_000)).toBe(3 + 7.5);
  });

  test("returns undefined for a model that is not in the table", () => {
    expect(computeLlmCostUsd(PRICES, "nope", 10, 10)).toBeUndefined();
  });
});

describe("bounded Ollama opt-in", () => {
  test("rejects non-loopback and cloud model configurations", () => {
    const env = { OLLAMA_BOUNDED_OUTPUT: "1" };
    for (const config of [
      parseConfig({ PROFILE: "local", OLLAMA_BASE_URL: "https://ollama.com/v1" }),
      parseConfig({ PROFILE: "local", OLLAMA_MODEL_MAIN: "example:cloud" }),
    ]) {
      expect(() => createAiSdkLlmProvider(config, "ollama", { env })).toThrow(/loopback/);
    }
  });

  test("does not retry bounded local network errors", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("connection refused"); });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = createAiSdkLlmProvider(parseConfig({ PROFILE: "local" }), "ollama", {
        env: { OLLAMA_BOUNDED_OUTPUT: "1" },
      });
      await expect(provider.generateObject({ slot: "main", ...request, localTimeoutMs: 900_000 })).rejects.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test("aborts an unresponsive request at its deadline without retry", async () => {
    const nativeTimeout = AbortSignal.timeout;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = createAiSdkLlmProvider(parseConfig({ PROFILE: "local" }), "ollama", {
        env: { OLLAMA_BOUNDED_OUTPUT: "1" },
      });
      await expect(provider.generateObject({ slot: "main", ...request })).rejects.toBeDefined();
      expect(timeoutSpy).toHaveBeenCalledWith(180_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  test("honours the longer bounded local merge deadline without retries", async () => {
    const nativeTimeout = AbortSignal.timeout;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = createAiSdkLlmProvider(parseConfig({ PROFILE: "local" }), "ollama", {
        env: { OLLAMA_BOUNDED_OUTPUT: "1" },
      });
      await expect(provider.generateObject({ slot: "fast", ...request, localTimeoutMs: 900_000 })).rejects.toBeDefined();
      expect(timeoutSpy).toHaveBeenCalledWith(900_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  test("streams long local structured responses and validates them", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return new Response(
        'data: {"id":"x","model":"tiny","choices":[{"index":0,"delta":{"content":"{\\"city\\":\\"Paris\\",\\"population\\":10}"},"finish_reason":null}]}\n\n' +
          'data: {"id":"x","model":"tiny","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
          'data: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = createAiSdkLlmProvider(parseConfig({ PROFILE: "local" }), "ollama", {
        env: { OLLAMA_BOUNDED_OUTPUT: "1" },
      });
      const result = await provider.generateObject({ slot: "fast", ...request, localTimeoutMs: 900_000 });
      expect(result.object).toEqual({ city: "Paris", population: 10 });
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBe(8192);
      expect(body.reasoning_effort).toBe("none");
      expect(body.response_format.type).toBe("json_schema");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test("aborts a stalled streaming body at the deadline without retry", async () => {
    const nativeTimeout = AbortSignal.timeout;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(20));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = createAiSdkLlmProvider(parseConfig({ PROFILE: "local" }), "ollama", {
        env: { OLLAMA_BOUNDED_OUTPUT: "1" },
      });
      await expect(provider.generateObject({ slot: "main", ...request, localTimeoutMs: 900_000 })).rejects.toBeDefined();
      expect(timeoutSpy).toHaveBeenCalledWith(900_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  test("retries a streamed schema refinement failure with feedback", async () => {
    const fetchMock = vi.fn(async () => new Response(
      'data: {"id":"x","model":"tiny","choices":[{"index":0,"delta":{"content":"{\\"city\\":\\"Paris\\",\\"population\\":10}"},"finish_reason":null}]}\n\n' +
      'data: {"id":"x","model":"tiny","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = createAiSdkLlmProvider(parseConfig({ PROFILE: "local" }), "ollama", {
        env: { OLLAMA_BOUNDED_OUTPUT: "1" },
      });
      await expect(provider.generateObject({
        slot: "main", ...request, localTimeoutMs: 900_000,
        schema: CitySchema.refine((value) => value.population > 100),
      })).rejects.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test("sends bounded structured output and disables thinking, failing closed after retry", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        void url;
        void init;
        return new Response(
          JSON.stringify({
            id: "test",
            model: "tiny",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: WRONG_SHAPE },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = createAiSdkLlmProvider(parseConfig({ PROFILE: "local" }), "ollama", {
        env: { OLLAMA_BOUNDED_OUTPUT: "1" },
      });
      await expect(provider.generateObject({ slot: "main", ...request })).rejects.toThrow(
        /2 attempts[\s\S]*population/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
      expect(JSON.stringify(retryBody.messages)).toContain("population");
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.max_tokens).toBe(8192);
      expect(body.reasoning_effort).toBe("none");
      expect(body.response_format.type).toBe("json_schema");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("createAiSdkLlmProvider", () => {
  const cloud = {
    LLM_MODEL_MAIN: "big-model",
    LLM_MODEL_FAST: "small-model",
  };

  test("builds a provider for each cloud provider when key and model ids are set", () => {
    const anthropic = parseConfig({ ...cloud, ANTHROPIC_API_KEY: "test-key" });
    const openai = parseConfig({ ...cloud, LLM_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
    const google = parseConfig({ ...cloud, LLM_PROVIDER: "google" });

    expect(createAiSdkLlmProvider(anthropic, "anthropic").modelIds).toEqual({
      main: "big-model",
      fast: "small-model",
    });
    expect(createAiSdkLlmProvider(openai, "openai")).toBeInstanceOf(AiSdkLlmProvider);
    expect(
      createAiSdkLlmProvider(google, "google", {
        env: { GOOGLE_GENERATIVE_AI_API_KEY: "test-key" },
      }),
    ).toBeInstanceOf(AiSdkLlmProvider);
  });

  test("Ollama needs no key and takes its model ids from OLLAMA_MODEL_*", () => {
    const config = parseConfig({
      PROFILE: "local",
      OLLAMA_MODEL_MAIN: "local-big",
      OLLAMA_MODEL_FAST: "local-small",
    });
    const provider = createAiSdkLlmProvider(config, "ollama", { env: {} });
    expect(provider.providerName).toBe("ollama");
    expect(provider.modelIds).toEqual({ main: "local-big", fast: "local-small" });
  });

  test("a missing API key fails at construction and names the variable", () => {
    expect(() => createAiSdkLlmProvider(parseConfig(cloud), "anthropic")).toThrowError(
      /anthropic.*ANTHROPIC_API_KEY/s,
    );
    expect(() =>
      createAiSdkLlmProvider(parseConfig({ ...cloud, LLM_PROVIDER: "openai" }), "openai"),
    ).toThrowError(/OPENAI_API_KEY/);
    expect(() =>
      createAiSdkLlmProvider(parseConfig({ ...cloud, LLM_PROVIDER: "google" }), "google", {
        env: {},
      }),
    ).toThrowError(/GOOGLE_GENERATIVE_AI_API_KEY/);
  });

  test("a missing model id fails at construction and names every missing variable", () => {
    const noModels = parseConfig({ ANTHROPIC_API_KEY: "test-key" });
    expect(() => createAiSdkLlmProvider(noModels, "anthropic")).toThrowError(
      /LLM_MODEL_MAIN.*LLM_MODEL_FAST/s,
    );

    const noFast = parseConfig({ ANTHROPIC_API_KEY: "test-key", LLM_MODEL_MAIN: "big-model" });
    const error = (() => {
      try {
        createAiSdkLlmProvider(noFast, "anthropic");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain("LLM_MODEL_FAST");
    expect(error?.message).not.toContain("LLM_MODEL_MAIN");
  });

  test("the error message never contains the key itself", () => {
    const config = parseConfig({ ANTHROPIC_API_KEY: "very-secret-value" });
    expect(() => createAiSdkLlmProvider(config, "anthropic")).toThrowError(
      expect.not.stringContaining("very-secret-value"),
    );
  });
});

describe("createLlmProvider (factory)", () => {
  test("returns the AI SDK provider for the cloud provider named in config", () => {
    const config = parseConfig({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
      LLM_MODEL_MAIN: "big-model",
      LLM_MODEL_FAST: "small-model",
    });
    const provider = createLlmProvider(config);
    expect(provider).toBeInstanceOf(AiSdkLlmProvider);
    expect((provider as AiSdkLlmProvider).providerName).toBe("openai");
  });

  test("returns the Ollama provider on the local profile", () => {
    const provider = createLlmProvider(parseConfig({ PROFILE: "local" }));
    expect(provider).toBeInstanceOf(AiSdkLlmProvider);
    expect((provider as AiSdkLlmProvider).providerName).toBe("ollama");
  });
});
