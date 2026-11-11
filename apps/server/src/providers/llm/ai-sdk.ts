// The real LlmProvider, on the Vercel AI SDK (v7). Structured output is `generateText` with
// `output: Output.object({ schema })`: the SDK sends the JSON schema to the model, parses
// the reply and validates it with the zod schema, rejecting with NoObjectGeneratedError
// when the reply is not JSON or does not match.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  type LanguageModel,
} from "ai";
import { formatZodError, type AppConfig, type LlmProviderName } from "shared";
import type { ZodType } from "zod";
import { computeLlmCostUsd, LLM_PRICES, type LlmPriceTable } from "../../config.ts";
import type {
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmProvider,
  LlmSlot,
  Usage,
} from "./interface.ts";

/** The AI SDK retries nothing about content; this is our own limit: one retry. */
const MAX_ATTEMPTS = 2;

export interface SlotModel {
  /** Model id from config; reported in `Usage.model` and looked up in the price table. */
  id: string;
  model: LanguageModel;
}

export interface AiSdkLlmProviderOptions {
  /** Reported in `Usage.provider`, e.g. "anthropic", "ollama". */
  provider: string;
  models: Record<LlmSlot, SlotModel>;
  /** USD per million tokens by model id, or "free" for local models. */
  prices: LlmPriceTable | "free";
  /** Receives the "no price for model" warning; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * The model answered, but not with an object matching the schema, on every attempt.
 * `usage` covers all attempts: they were billed even though nothing usable came back.
 */
export class LlmOutputError extends Error {
  override readonly name = "LlmOutputError";
  readonly usage: Usage;

  constructor(message: string, usage: Usage, options?: ErrorOptions) {
    super(message, options);
    this.usage = usage;
  }
}

export class AiSdkLlmProvider implements LlmProvider {
  readonly providerName: string;
  private readonly models: Record<LlmSlot, SlotModel>;
  private readonly prices: LlmPriceTable | "free";
  private readonly warn: (message: string) => void;
  private readonly warnedModels = new Set<string>();

  constructor(options: AiSdkLlmProviderOptions) {
    this.providerName = options.provider;
    this.models = options.models;
    this.prices = options.prices;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** The model id behind each slot. */
  get modelIds(): Record<LlmSlot, string> {
    return { main: this.models.main.id, fast: this.models.fast.id };
  }

  async generateObject<T>(request: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const { id, model } = this.models[request.slot];
    let inputTokens = 0;
    let outputTokens = 0;
    let lastProblem = "";
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // No tools: stages pass untrusted source text in `prompt`.
        const result = await generateText({
          model,
          instructions: request.system,
          prompt: request.prompt,
          output: Output.object({ schema: request.schema }),
        });
        inputTokens += result.usage.inputTokens ?? 0;
        outputTokens += result.usage.outputTokens ?? 0;
        // A getter: throws NoOutputGeneratedError if the model stopped without an answer.
        const object = result.output as T;
        return { object, usage: this.usage(id, inputTokens, outputTokens) };
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          inputTokens += error.usage?.inputTokens ?? 0;
          outputTokens += error.usage?.outputTokens ?? 0;
          lastProblem = describeInvalidOutput(error, request.schema);
        } else if (NoOutputGeneratedError.isInstance(error)) {
          lastProblem = "the model stopped without producing an answer";
        } else {
          // Network, auth, rate limit…: the SDK already retried what is retryable.
          throw error;
        }
        lastError = error;
      }
    }

    throw new LlmOutputError(
      `LLM ${this.providerName}/${id} (slot "${request.slot}") did not return a valid object ` +
        `after ${MAX_ATTEMPTS} attempts:\n${lastProblem}`,
      this.usage(id, inputTokens, outputTokens),
      { cause: lastError },
    );
  }

  private usage(model: string, inputTokens: number, outputTokens: number): Usage {
    return {
      provider: this.providerName,
      model,
      inputTokens,
      outputTokens,
      costUsd: this.cost(model, inputTokens, outputTokens),
    };
  }

  private cost(model: string, inputTokens: number, outputTokens: number): number {
    if (this.prices === "free") return 0;
    const cost = computeLlmCostUsd(this.prices, model, inputTokens, outputTokens);
    if (cost !== undefined) return cost;
    if (!this.warnedModels.has(model)) {
      this.warnedModels.add(model);
      this.warn(
        `No price configured for LLM model "${model}": its cost is recorded as 0. ` +
          `Add it to LLM_PRICES in apps/server/src/config.ts.`,
      );
    }
    return 0;
  }
}

const EXCERPT_CHARS = 200;

/** Why the reply was rejected, in terms of the caller's schema where possible. */
function describeInvalidOutput(error: NoObjectGeneratedError, schema: ZodType): string {
  const text = error.text;
  if (text === undefined || text.trim() === "") return "the response was empty";

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const excerpt = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
    return `the response was not valid JSON: ${excerpt}`;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return formatZodError(parsed.error);
  // Valid by our own check, yet rejected by the SDK (e.g. the output was cut off).
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

// ---------------------------------------------------------------------------------------
// Construction from config
// ---------------------------------------------------------------------------------------

export type AiSdkProviderName = LlmProviderName | "ollama";

/**
 * Environment variable holding the API key of each cloud provider. The Google key is not
 * part of the shared config schema yet, so it is read from the environment directly,
 * under the name the AI SDK itself uses.
 */
export const LLM_API_KEY_VARIABLES: Record<LlmProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export interface CreateAiSdkLlmProviderOptions {
  /** Where the Google key is looked up; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  prices?: LlmPriceTable;
  warn?: (message: string) => void;
}

/** The API key of a cloud provider, or `undefined` when it is not set. */
export function findLlmApiKey(
  config: AppConfig,
  name: LlmProviderName,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const key =
    name === "anthropic"
      ? config.ANTHROPIC_API_KEY
      : name === "openai"
        ? config.OPENAI_API_KEY
        : env[LLM_API_KEY_VARIABLES.google];
  return key === undefined || key.trim() === "" ? undefined : key;
}

/**
 * Builds the provider `name` from config. Throws a message naming every missing variable
 * (API key, model ids) instead of failing later on the first call.
 */
export function createAiSdkLlmProvider(
  config: AppConfig,
  name: AiSdkProviderName,
  options: CreateAiSdkLlmProviderOptions = {},
): AiSdkLlmProvider {
  if (name === "ollama") {
    const ollama = createOpenAICompatible({
      name: "ollama",
      baseURL: config.OLLAMA_BASE_URL,
      // Sends the JSON schema as `response_format`, which Ollama enforces while decoding.
      supportsStructuredOutputs: true,
    });
    return new AiSdkLlmProvider({
      provider: "ollama",
      models: {
        main: { id: config.OLLAMA_MODEL_MAIN, model: ollama.chatModel(config.OLLAMA_MODEL_MAIN) },
        fast: { id: config.OLLAMA_MODEL_FAST, model: ollama.chatModel(config.OLLAMA_MODEL_FAST) },
      },
      prices: "free",
      warn: options.warn,
    });
  }

  const apiKey = findLlmApiKey(config, name, options.env);
  const mainId = config.LLM_MODEL_MAIN;
  const fastId = config.LLM_MODEL_FAST;
  const missing = [
    apiKey === undefined ? LLM_API_KEY_VARIABLES[name] : undefined,
    mainId === undefined ? "LLM_MODEL_MAIN" : undefined,
    fastId === undefined ? "LLM_MODEL_FAST" : undefined,
  ].filter((variable) => variable !== undefined);
  if (apiKey === undefined || mainId === undefined || fastId === undefined) {
    throw new Error(
      `Cannot use the "${name}" LLM provider: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. Set ${missing.length === 1 ? "it" : "them"} in .env ` +
        `(model ids are listed in the provider's documentation).`,
    );
  }

  const model = languageModelFactory(name, apiKey);
  return new AiSdkLlmProvider({
    provider: name,
    models: {
      main: { id: mainId, model: model(mainId) },
      fast: { id: fastId, model: model(fastId) },
    },
    prices: options.prices ?? LLM_PRICES,
    warn: options.warn,
  });
}

function languageModelFactory(
  name: LlmProviderName,
  apiKey: string,
): (modelId: string) => LanguageModel {
  switch (name) {
    case "anthropic": {
      const provider = createAnthropic({ apiKey });
      return (modelId) => provider(modelId);
    }
    case "openai": {
      const provider = createOpenAI({ apiKey });
      return (modelId) => provider(modelId);
    }
    case "google": {
      const provider = createGoogle({ apiKey });
      return (modelId) => provider(modelId);
    }
  }
}
