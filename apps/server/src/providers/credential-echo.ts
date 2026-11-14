import type { AppConfig } from "shared";
import type { Providers } from "./index.ts";

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
  function check<T>(value: T): T {
    if (!patterns.length) return value;
    const seen = new WeakSet<object>();
    function scan(input: unknown): void {
      if (typeof input === "string") {
        if (patterns.some((pattern) => input.includes(pattern) || input.toLowerCase().includes(pattern.toLowerCase()))) throw new Error(CREDENTIAL_ECHO_WARNING);
      } else if (typeof input === "object" && input !== null) {
        if (seen.has(input)) throw new Error(CREDENTIAL_ECHO_WARNING);
        seen.add(input);
        for (const [key, item] of Object.entries(input)) { scan(key); scan(item); }
      }
    }
    try { scan(value); } catch { throw new Error(CREDENTIAL_ECHO_WARNING); }
    return value;
  }
  const { llm, search, extractor } = providers;
  return {
    ...providers,
    llm: {
      get localCacheIdentity() { return llm.localCacheIdentity; },
      get cacheIdentity() { return llm.cacheIdentity; },
      get diagnostic() { return llm.diagnostic; },
      async generateObject(request) { return check(await llm.generateObject(request)); },
    },
    search: { async search(query, options) { return check(await search.search(query, options)); } },
    extractor: { async extract(url) { return check(await extractor.extract(url)); } },
  };
}
