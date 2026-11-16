import type { AppConfig } from "shared";
import type { Providers } from "./index.ts";
import { safeUsageModel, safeUsageProvider, type Usage } from "./llm/interface.ts";

export const CREDENTIAL_ECHO_WARNING = "Provider output blocked: possible credential exposure";

/** Bounded matching only; it cannot identify arbitrary transformations or unseen credentials. */
export function guardProviderResults(providers: Providers, config: AppConfig): Providers {
  const secrets = [config.ANTHROPIC_API_KEY, config.OPENAI_API_KEY, process.env.GOOGLE_GENERATIVE_AI_API_KEY, config.TAVILY_API_KEY,
    config.BRAVE_API_KEY, config.AZURE_SPEECH_KEY, config.ELEVENLABS_API_KEY, config.FISH_AUDIO_API_KEY]
    .filter((value): value is string => Boolean(value));
  const patterns = secrets.flatMap((secret) => {
    const base64 = Buffer.from(secret).toString("base64");
    return [secret, encodeURIComponent(secret), base64, base64.replace(/=+$/, ""), Buffer.from(secret).toString("base64url")];
  });
  /**
   * Returns a plain copy built from the very values that were scanned. Each property is read
   * once, so a getter or proxy cannot show the scanner one value and the pipeline another.
   * Anything that is not plain data (class instances, functions, cycles, shared references)
   * cannot be copied faithfully and is blocked.
   */
  function check<T>(value: T): T {
    if (!patterns.length) return value;
    const seen = new WeakSet<object>();
    function snapshot(input: unknown): unknown {
      if (typeof input === "string") {
        if (patterns.some((pattern) => input.includes(pattern) || input.toLowerCase().includes(pattern.toLowerCase()))) throw new Error(CREDENTIAL_ECHO_WARNING);
        return input;
      }
      if (typeof input === "function" || typeof input === "symbol") throw new Error(CREDENTIAL_ECHO_WARNING);
      if (typeof input !== "object" || input === null) return input;
      if (seen.has(input)) throw new Error(CREDENTIAL_ECHO_WARNING);
      seen.add(input);
      if (Array.isArray(input)) {
        const copy: unknown[] = [];
        const length = input.length;
        for (let index = 0; index < length; index++) copy.push(snapshot(input[index]));
        return copy;
      }
      const prototype: unknown = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(CREDENTIAL_ECHO_WARNING);
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        snapshot(key);
        Object.defineProperty(copy, key, { value: snapshot((input as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
      }
      return copy;
    }
    try { return snapshot(value) as T; } catch { throw new Error(CREDENTIAL_ECHO_WARNING); }
  }
  /**
   * A blocked answer was still billed. Valid usage travels on the error, with provider and
   * model reduced to known labels. Usage that is present but cannot be trusted leaves an
   * empty `usage` marker, which the meter records as unreconciled spend that stops the budget.
   */
  function blocked(result: unknown): Error {
    const error = new Error(CREDENTIAL_ECHO_WARNING);
    let present = true;
    let usage: Usage | undefined;
    try {
      const raw: unknown = typeof result === "object" && result !== null ? (result as { usage?: unknown }).usage : undefined;
      if (raw === undefined) present = false;
      else if (typeof raw === "object" && raw !== null) {
        const { provider, model, inputTokens, outputTokens, costUsd } = raw as Partial<Usage>;
        const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
        if (typeof provider === "string" && typeof model === "string" && amount(inputTokens) && amount(outputTokens) && amount(costUsd))
          usage = { provider: safeUsageProvider(provider), model: safeUsageModel(model), inputTokens, outputTokens, costUsd };
      }
    } catch { usage = undefined; }
    if (present) Object.defineProperty(error, "usage", { value: usage });
    return error;
  }
  const { llm, search, extractor } = providers;
  return {
    ...providers,
    llm: {
      get localCacheIdentity() { return llm.localCacheIdentity; },
      get cacheIdentity() { return llm.cacheIdentity; },
      get diagnostic() { return llm.diagnostic; },
      async generateObject(request) {
        const result = await llm.generateObject(request);
        try { return check(result); } catch { throw blocked(result); }
      },
    },
    search: { async search(query, options) { return check(await search.search(query, options)); } },
    extractor: { async extract(url) { return check(await extractor.extract(url)); } },
  };
}
