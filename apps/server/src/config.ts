import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { parseConfig, type AppConfig } from "shared";

/** The repository root: where `.env` lives and what a relative DATA_DIR is resolved against. */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface LoadConfigOptions {
  /** Directory holding `.env`; relative DATA_DIR values are resolved against it. */
  rootDir?: string;
  /** Environment variables; they win over `.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Loads `<rootDir>/.env` if present, overlays the real environment and parses the result
 * with the shared schema. Throws one readable error naming every invalid variable.
 * `DATA_DIR` comes back as an absolute path. Nothing is written to `process.env`.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig & { OLLAMA_BOUNDED_OUTPUT: boolean } {
  const rootDir = path.resolve(options.rootDir ?? REPO_ROOT);
  const env = options.env ?? process.env;
  const envFile = path.join(rootDir, ".env");
  const hasEnvFile = existsSync(envFile);
  const fromFile = hasEnvFile ? parseEnv(readFileSync(envFile, "utf8")) : {};

  const merged = { ...fromFile, ...definedOnly(env) };
  let config: AppConfig;
  try {
    config = parseConfig(merged);
  } catch (error) {
    const source = hasEnvFile ? `environment and ${envFile}` : "environment";
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      details.replace(/^Invalid configuration:/, `Invalid configuration (${source}):`),
      {
        cause: error,
      },
    );
  }
  return { ...config, DATA_DIR: path.resolve(rootDir, config.DATA_DIR), OLLAMA_BOUNDED_OUTPUT: merged.OLLAMA_BOUNDED_OUTPUT === "1" };
}

/** An unset or blank variable must not hide a value from `.env`. */
function definedOnly(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Prices (ARCHITECTURE §3 "Cost guard")
// ---------------------------------------------------------------------------------------

/** What one model costs, in USD per million tokens. */
export interface LlmPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** Prices keyed by the exact model id used in `LLM_MODEL_MAIN` / `LLM_MODEL_FAST`. */
export type LlmPriceTable = Readonly<Record<string, LlmPrice>>;

/**
 * EDIT ME. Add one line per cloud AI SDK model id you put in `.env`, with prices from the
 * provider's current pricing page (do not trust remembered numbers). Missing or invalid
 * rates are refused before a provider call. Local (Ollama) models need no entry. ChatGPT
 * subscription usage uses a separate provider and is not priced by this table.
 */
export const LLM_PRICES: LlmPriceTable = {
  // EXAMPLE ONLY: a made-up model id with made-up prices, to show the format.
  "example-model-id": { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
};

/** Estimated cost of one call, or `undefined` when the model has no entry in the table. */
export function computeLlmCostUsd(
  prices: LlmPriceTable,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  if (!Object.hasOwn(prices, model)) return undefined;
  const price = prices[model]!;
  return (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) / 1_000_000;
}
