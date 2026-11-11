import { describe, expect, test } from "vitest";
import { ConfigSchema, formatZodError, parseConfig } from "./index.ts";
import { expectInvalid } from "./testing.ts";

// Mirrors .env.example as dotenv would load it (inline comments stripped, blanks kept as "").
const envExample = {
  PROFILE: "cloud",
  HOST: "127.0.0.1",
  PORT: "4747",
  DATA_DIR: "./data",
  MONTHLY_BUDGET_USD: "20",
  NATIVE_LANG: "en",
  TARGET_LANG: "hu",
  LEARNER_LEVEL: "A1",
  LLM_PROVIDER: "anthropic",
  LLM_MODEL_MAIN: "",
  LLM_MODEL_FAST: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  OLLAMA_BASE_URL: "http://localhost:11434/v1",
  OLLAMA_MODEL_MAIN: "qwen3.5:4b",
  OLLAMA_MODEL_FAST: "qwen3.5:4b",
  SEARCH_PROVIDER: "tavily",
  TAVILY_API_KEY: "",
  BRAVE_API_KEY: "",
  SEARXNG_URL: "http://localhost:8888",
  TTS_PROVIDER: "azure",
  AZURE_SPEECH_KEY: "",
  AZURE_SPEECH_REGION: "westeurope",
  TTS_VOICE_HU_HOST: "hu-HU-NoemiNeural",
  TTS_VOICE_HU_COHOST: "hu-HU-TamasNeural",
  TTS_VOICE_NATIVE_HOST: "",
  TTS_VOICE_NATIVE_TEACHER: "",
  ELEVENLABS_API_KEY: "",
  PIPER_DIR: "./infra/piper",
};

const cloudDefaults = {
  PROFILE: "cloud",
  HOST: "127.0.0.1",
  PORT: 4747,
  DATA_DIR: "./data",
  MONTHLY_BUDGET_USD: 20,
  NATIVE_LANG: "en",
  TARGET_LANG: "hu",
  LEARNER_LEVEL: "A1",
  ALLOW_LOCAL_LEARNING: false,
  LLM_PROVIDER: "anthropic",
  OLLAMA_BASE_URL: "http://localhost:11434/v1",
  OLLAMA_MODEL_MAIN: "qwen3.5:4b",
  OLLAMA_MODEL_FAST: "qwen3.5:4b",
  SEARCH_PROVIDER: "tavily",
  SEARXNG_URL: "http://localhost:8888",
  TTS_PROVIDER: "azure",
  AZURE_SPEECH_REGION: "westeurope",
  TTS_VOICE_HU_HOST: "hu-HU-NoemiNeural",
  TTS_VOICE_HU_COHOST: "hu-HU-TamasNeural",
  PIPER_DIR: "./infra/piper",
};

describe("config", () => {
  test("an empty environment gives the cloud defaults from .env.example", () => {
    expect(parseConfig({})).toEqual(cloudDefaults);
  });

  test(".env.example itself parses to the same defaults (blank values count as unset)", () => {
    expect(parseConfig(envExample)).toEqual(cloudDefaults);
  });

  test("PROFILE=local switches the search and TTS defaults to the local providers", () => {
    expect(parseConfig({ PROFILE: "local" })).toEqual({
      ...cloudDefaults,
      PROFILE: "local",
      SEARCH_PROVIDER: "searxng",
      TTS_PROVIDER: "piper",
    });
  });

  test("explicit provider choices win over the profile defaults", () => {
    const config = parseConfig({
      PROFILE: "local",
      SEARCH_PROVIDER: "brave",
      TTS_PROVIDER: "openai",
    });
    expect(config.SEARCH_PROVIDER).toBe("brave");
    expect(config.TTS_PROVIDER).toBe("openai");
  });

  test("local and LAN service URLs are accepted", () => {
    const config = parseConfig({
      OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
      SEARXNG_URL: "http://192.168.1.20:8888",
    });
    expect(config.OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(config.SEARXNG_URL).toBe("http://192.168.1.20:8888");
  });

  test("numbers and booleans are coerced from strings", () => {
    const config = parseConfig({
      PORT: "8080",
      MONTHLY_BUDGET_USD: "7.5",
      ALLOW_LOCAL_LEARNING: "1",
    });
    expect(config.PORT).toBe(8080);
    expect(config.MONTHLY_BUDGET_USD).toBe(7.5);
    expect(config.ALLOW_LOCAL_LEARNING).toBe(true);
  });

  test("secrets and model ids are optional at parse time and passed through when set", () => {
    const config = parseConfig({
      ANTHROPIC_API_KEY: "sk-test",
      LLM_MODEL_MAIN: "model-a",
      LLM_MODEL_FAST: "model-b",
      TTS_VOICE_NATIVE_HOST: "en-US-AvaNeural",
    });
    expect(config.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(config.LLM_MODEL_MAIN).toBe("model-a");
    expect(config.LLM_MODEL_FAST).toBe("model-b");
    expect(config.TTS_VOICE_NATIVE_HOST).toBe("en-US-AvaNeural");
    expect(config.OPENAI_API_KEY).toBeUndefined();
  });

  test("unrelated environment variables are ignored, including undefined ones", () => {
    const config = parseConfig({ PATH: "/usr/bin", HOME: undefined, PORT: undefined });
    expect(config).toEqual(cloudDefaults);
  });

  test("rejects an unknown profile and providers, listing the options", () => {
    expectInvalid(ConfigSchema, { PROFILE: "hybrid" }, /PROFILE.*cloud.*local/);
    expectInvalid(ConfigSchema, { LLM_PROVIDER: "mistral" }, /LLM_PROVIDER.*anthropic/);
    expectInvalid(ConfigSchema, { SEARCH_PROVIDER: "google" }, /SEARCH_PROVIDER.*tavily/);
    expectInvalid(ConfigSchema, { TTS_PROVIDER: "espeak" }, /TTS_PROVIDER.*azure/);
  });

  test("rejects bad numbers, URLs and levels", () => {
    expectInvalid(ConfigSchema, { PORT: "http" }, /PORT/);
    expectInvalid(ConfigSchema, { PORT: "70000" }, /PORT.*65535/);
    expectInvalid(ConfigSchema, { PORT: "47.5" }, /PORT/);
    expectInvalid(ConfigSchema, { MONTHLY_BUDGET_USD: "-5" }, /MONTHLY_BUDGET_USD/);
    expectInvalid(ConfigSchema, { MONTHLY_BUDGET_USD: "twenty" }, /MONTHLY_BUDGET_USD/);
    expectInvalid(ConfigSchema, { OLLAMA_BASE_URL: "localhost" }, /OLLAMA_BASE_URL/);
    expectInvalid(ConfigSchema, { SEARXNG_URL: "not a url" }, /SEARXNG_URL/);
    expectInvalid(ConfigSchema, { SEARXNG_URL: "ftp://localhost:8888" }, /SEARXNG_URL.*http/);
    expectInvalid(ConfigSchema, { LEARNER_LEVEL: "C2" }, /LEARNER_LEVEL.*A1/);
    expectInvalid(ConfigSchema, { ALLOW_LOCAL_LEARNING: "maybe" }, /ALLOW_LOCAL_LEARNING/);
  });

  test("parseConfig throws one readable error naming every bad variable", () => {
    expect(() => parseConfig({ PROFILE: "hybrid", PORT: "abc" })).toThrowError(
      /Invalid configuration[\s\S]*PROFILE[\s\S]*PORT/,
    );
  });

  test("a rejected non-object is reported", () => {
    const result = ConfigSchema.safeParse("PROFILE=cloud");
    expect(result.success).toBe(false);
    if (!result.success) expect(formatZodError(result.error)).toMatch(/object/);
  });
});
