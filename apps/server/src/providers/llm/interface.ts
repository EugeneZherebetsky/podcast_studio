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

/**
 * The usage a provider attached to the error of a failed call (as `error.usage`) because
 * the call was billed anyway, e.g. the model answered but never with a valid object.
 */
export function usageOfFailedCall(error: unknown): Usage | undefined {
  if (!(error instanceof Error) || !("usage" in error)) return undefined;
  const usage = error.usage as Partial<Usage> | null | undefined;
  if (
    typeof usage?.provider !== "string" ||
    typeof usage.model !== "string" ||
    !Number.isFinite(usage.inputTokens) ||
    !Number.isFinite(usage.outputTokens) ||
    !Number.isFinite(usage.costUsd)
  )
    return undefined;
  return usage as Usage;
}

export interface GenerateObjectRequest<T> {
  slot: LlmSlot;
  system: string;
  prompt: string;
  /** Deadline override for opt-in bounded local generation; ignored by cloud providers. */
  localTimeoutMs?: number;
  /** Called before a provider-internal retry to respect cancellation. */
  assertContinue?: () => void;
  /** The response is validated against this schema; `object` is the parsed value. */
  schema: ZodType<T>;
}

export interface GenerateObjectResult<T> {
  object: T;
  usage?: Usage;
}

/** Structured generation only, with no tools: stages pass untrusted source text in `prompt`. */
export interface LlmProvider {
  readonly diagnostic?: { provider: string; models: Record<LlmSlot, string> };
  /** Stable, secret-free identity for free local map caching; absent disables it. */
  readonly localCacheIdentity?: string;
  /** Provider and model identity used only to scope stage caches. */
  readonly cacheIdentity?: string;
  generateObject<T>(request: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>>;
}
