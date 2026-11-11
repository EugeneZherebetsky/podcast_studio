import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseConfig } from "shared";
import { z } from "zod";
import { FakeExtractor } from "../src/providers/extract/fake.ts";
import {
  createExtractor,
  createFakeProviders,
  createProviders,
  createSearchProvider,
  createTtsProvider,
  selectProviderNames,
} from "../src/providers/index.ts";
import { FakeLlmProvider } from "../src/providers/llm/fake.ts";
import { FakeSearchProvider } from "../src/providers/search/fake.ts";
import { FakeTtsProvider } from "../src/providers/tts/fake.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => removeTempDir(dir));

test("the cloud profile selects the configured cloud providers", () => {
  expect(selectProviderNames(parseConfig({}))).toEqual({
    llm: "anthropic",
    search: "tavily",
    extractor: "readability",
    tts: "azure",
  });
});

test("the local profile selects Ollama, SearXNG and Piper", () => {
  expect(selectProviderNames(parseConfig({ PROFILE: "local" }))).toEqual({
    llm: "ollama",
    search: "searxng",
    extractor: "readability",
    tts: "piper",
  });
});

test("the local profile ignores LLM_PROVIDER: its LLM is always Ollama", () => {
  const config = parseConfig({ PROFILE: "local", LLM_PROVIDER: "openai" });
  expect(selectProviderNames(config).llm).toBe("ollama");
});

test("explicit provider names win over the profile defaults", () => {
  const cloud = parseConfig({
    LLM_PROVIDER: "openai",
    SEARCH_PROVIDER: "brave",
    TTS_PROVIDER: "elevenlabs",
  });
  expect(selectProviderNames(cloud)).toMatchObject({
    llm: "openai",
    search: "brave",
    tts: "elevenlabs",
  });

  const local = parseConfig({ PROFILE: "local", SEARCH_PROVIDER: "tavily", TTS_PROVIDER: "azure" });
  expect(selectProviderNames(local)).toMatchObject({
    llm: "ollama",
    search: "tavily",
    tts: "azure",
  });
});

test("each non-LLM slot fails with 'not implemented yet' naming the selected provider", () => {
  const cloud = parseConfig({});
  const local = parseConfig({ PROFILE: "local" });
  const brave = parseConfig({ SEARCH_PROVIDER: "brave", LLM_PROVIDER: "google" });

  expect(() => createSearchProvider(cloud)).toThrowError("not implemented yet: search/tavily");
  expect(() => createSearchProvider(local)).toThrowError("not implemented yet: search/searxng");
  expect(() => createSearchProvider(brave)).toThrowError("not implemented yet: search/brave");
  expect(() => createExtractor(cloud)).toThrowError("not implemented yet: extract/readability");
  expect(() => createTtsProvider(cloud)).toThrowError("not implemented yet: tts/azure");
  expect(() => createTtsProvider(local)).toThrowError("not implemented yet: tts/piper");
});

test("createProviders fails on the first unimplemented provider of the profile", () => {
  // LLM is implemented (T05). For local profile, LLM succeeds and search is the next slot.
  expect(() => createProviders(parseConfig({ PROFILE: "local" }))).toThrowError(
    /^not implemented yet: search\/searxng$/,
  );
});

test("createFakeProviders returns a working set of fakes", async () => {
  const providers = createFakeProviders({ wavDir: dir, llm: { responses: [{ ok: true }] } });

  expect(providers.llm).toBeInstanceOf(FakeLlmProvider);
  expect(providers.search).toBeInstanceOf(FakeSearchProvider);
  expect(providers.extractor).toBeInstanceOf(FakeExtractor);
  expect(providers.tts).toBeInstanceOf(FakeTtsProvider);

  const { object } = await providers.llm.generateObject({
    slot: "main",
    system: "s",
    prompt: "p",
    schema: z.object({ ok: z.boolean() }),
  });
  expect(object).toEqual({ ok: true });

  const [hit] = await providers.search.search("bees", { max: 1 });
  expect(await providers.extractor.extract(hit!.url)).not.toBeNull();

  const { wavPath } = await providers.tts.synthesize({
    text: "hi",
    lang: "en",
    voice: "fake-en-a",
    rate: 1,
  });
  expect(existsSync(wavPath)).toBe(true);
});

test("createFakeProviders passes options through to each fake", async () => {
  const hit = { url: "https://example.org/only", title: "Only", snippet: "one" };
  const providers = createFakeProviders({
    wavDir: dir,
    search: { hits: [hit] },
    extractor: { pages: { [hit.url]: { title: "Only", text: "text", site: "example.org" } } },
    tts: { msPerChar: 20, frequencyHz: 700 },
  });
  expect(await providers.search.search("q", { max: 5 })).toEqual([hit]);
  expect((await providers.extractor.extract(hit.url))?.text).toBe("text");
  expect(providers.tts.expectedSamples("abcd")).toBe(4 * 480);
});
