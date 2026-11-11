// The one place that decides which implementation serves each provider slot. Pipeline
// code receives a `Providers` object and never names a provider itself.
import type { AppConfig, LlmProviderName, SearchProviderName, TtsProviderName } from "shared";
import { FakeExtractor, type FakeExtractorOptions } from "./extract/fake.ts";
import type { Extractor } from "./extract/interface.ts";
import { ReadabilityExtractor } from "./extract/readability.ts";
import { createAiSdkLlmProvider } from "./llm/ai-sdk.ts";
import { FakeLlmProvider, type FakeLlmOptions } from "./llm/fake.ts";
import type { LlmProvider } from "./llm/interface.ts";
import { FakeSearchProvider, type FakeSearchOptions } from "./search/fake.ts";
import type { SearchProvider } from "./search/interface.ts";
import { BraveSearchProvider } from "./search/brave.ts";
import { SearxngSearchProvider } from "./search/searxng.ts";
import { TavilySearchProvider } from "./search/tavily.ts";
import { FakeTtsProvider, type FakeTtsOptions } from "./tts/fake.ts";
import type { TtsProvider } from "./tts/interface.ts";

export type * from "./extract/interface.ts";
export type * from "./llm/interface.ts";
export type * from "./search/interface.ts";
export type * from "./tts/interface.ts";
export { ReadabilityExtractor } from "./extract/readability.ts";
export { BraveSearchProvider } from "./search/brave.ts";
export { SearxngSearchProvider } from "./search/searxng.ts";
export { TavilySearchProvider } from "./search/tavily.ts";
export { canonicalizeUrl, deduplicateHits } from "./search/url.ts";

export interface Providers {
  llm: LlmProvider;
  search: SearchProvider;
  extractor: Extractor;
  tts: TtsProvider;
}

/** The local profile always uses Ollama; `LLM_PROVIDER` only applies to the cloud profile. */
export type LlmImplementationName = LlmProviderName | "ollama";
export type ExtractorImplementationName = "readability";

export interface ProviderNames {
  llm: LlmImplementationName;
  search: SearchProviderName;
  extractor: ExtractorImplementationName;
  tts: TtsProviderName;
}

/**
 * Which implementation each slot gets. `SEARCH_PROVIDER` and `TTS_PROVIDER` already carry
 * the profile default (cloud: tavily + azure, local: searxng + piper) unless set explicitly.
 */
export function selectProviderNames(config: AppConfig): ProviderNames {
  return {
    llm: config.PROFILE === "local" ? "ollama" : config.LLM_PROVIDER,
    search: config.SEARCH_PROVIDER,
    extractor: "readability",
    tts: config.TTS_PROVIDER,
  };
}

function notImplemented(provider: string): never {
  throw new Error(`not implemented yet: ${provider}`);
}

export function createLlmProvider(config: AppConfig): LlmProvider {
  const name = selectProviderNames(config).llm;
  return createAiSdkLlmProvider(config, name);
}

export function createSearchProvider(config: AppConfig): SearchProvider {
  const name = selectProviderNames(config).search;
  switch (name) {
    case "tavily": {
      if (!config.TAVILY_API_KEY) {
        throw new Error(
          'Cannot use the "tavily" search provider: TAVILY_API_KEY is not set. Set it in .env.',
        );
      }
      return new TavilySearchProvider({ apiKey: config.TAVILY_API_KEY });
    }
    case "brave": {
      if (!config.BRAVE_API_KEY) {
        throw new Error(
          'Cannot use the "brave" search provider: BRAVE_API_KEY is not set. Set it in .env.',
        );
      }
      return new BraveSearchProvider({ apiKey: config.BRAVE_API_KEY });
    }
    case "searxng": {
      if (!config.SEARXNG_URL) {
        throw new Error(
          'Cannot use the "searxng" search provider: SEARXNG_URL is not set. Set it in .env.',
        );
      }
      return new SearxngSearchProvider({ baseUrl: config.SEARXNG_URL });
    }
  }
}

export function createExtractor(config: AppConfig): Extractor {
  const name = selectProviderNames(config).extractor;
  switch (name) {
    case "readability":
      return new ReadabilityExtractor();
  }
}

export function createTtsProvider(config: AppConfig): TtsProvider {
  const name = selectProviderNames(config).tts;
  switch (name) {
    case "azure":
    case "openai":
    case "elevenlabs":
    case "piper":
      return notImplemented(`tts/${name}`); // T10 (piper: T26)
  }
}

/** Builds the real providers selected by the profile and the provider names in config. */
export function createProviders(config: AppConfig): Providers {
  return {
    llm: createLlmProvider(config),
    search: createSearchProvider(config),
    extractor: createExtractor(config),
    tts: createTtsProvider(config),
  };
}

export interface FakeProviders extends Providers {
  llm: FakeLlmProvider;
  search: FakeSearchProvider;
  extractor: FakeExtractor;
  tts: FakeTtsProvider;
}

export interface FakeProvidersOptions {
  /** Directory the fake TTS writes its WAV files to (a temp dir in tests). */
  wavDir: string;
  llm?: FakeLlmOptions;
  search?: FakeSearchOptions;
  extractor?: FakeExtractorOptions;
  tts?: Omit<FakeTtsOptions, "outDir">;
}

/**
 * The full set of deterministic fakes, for tests. Deliberately not reachable through
 * config: no environment value can make `createProviders` return a fake.
 */
export function createFakeProviders(options: FakeProvidersOptions): FakeProviders {
  return {
    llm: new FakeLlmProvider(options.llm),
    search: new FakeSearchProvider(options.search),
    extractor: new FakeExtractor(options.extractor),
    tts: new FakeTtsProvider({ ...options.tts, outDir: options.wavDir }),
  };
}
