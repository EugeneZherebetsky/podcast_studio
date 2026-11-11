import type { ZodType } from "zod";

/** Config has two model slots: `main` (script, review, Hungarian) and `fast` (plan, notes). */
export type LlmSlot = "main" | "fast";

/** What one LLM call consumed; the runner writes it to the `usage` table for the cost guard. */
export interface Usage {
  /** Implementation that served the call, e.g. "anthropic", "ollama". */
  provider: string;
  /** Model id that served the call. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from the token counts and the prices in config; 0 for local models. */
  costUsd: number;
}

export interface GenerateObjectRequest<T> {
  slot: LlmSlot;
  system: string;
  prompt: string;
  /** The response is validated against this schema; `object` is the parsed value. */
  schema: ZodType<T>;
}

export interface GenerateObjectResult<T> {
  object: T;
  usage: Usage;
}

/** Structured generation only, with no tools: stages pass untrusted source text in `prompt`. */
export interface LlmProvider {
  generateObject<T>(request: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>>;
}
