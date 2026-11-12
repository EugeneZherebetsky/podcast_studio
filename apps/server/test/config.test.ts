import { copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.ts";
import { createAiSdkLlmProvider } from "../src/providers/llm/ai-sdk.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => removeTempDir(dir));

function writeEnv(text: string): void {
  writeFileSync(path.join(dir, ".env"), text);
}

test("without a .env file and with an empty environment, returns the defaults", () => {
  const config = loadConfig({ rootDir: dir, env: {} });
  expect(config.PROFILE).toBe("cloud");
  expect(config.HOST).toBe("127.0.0.1");
  expect(config.PORT).toBe(4747);
  expect(config.SEARCH_PROVIDER).toBe("tavily");
});

test("reads values from .env, through the shared schema", () => {
  writeEnv("PROFILE=local\nPORT=5050\nANTHROPIC_API_KEY=\n");
  const config = loadConfig({ rootDir: dir, env: {} });
  expect(config.PROFILE).toBe("local");
  expect(config.PORT).toBe(5050);
  expect(config.TTS_PROVIDER).toBe("piper"); // profile default, applied by the shared schema
  expect(config.ANTHROPIC_API_KEY).toBeUndefined();
});

test("the repo's .env.example loads, inline comments included", () => {
  copyFileSync(path.join(REPO_ROOT, ".env.example"), path.join(dir, ".env"));
  const config = loadConfig({ rootDir: dir, env: {} });
  expect(config.PROFILE).toBe("cloud");
  expect(config.HOST).toBe("127.0.0.1");
  expect(config.LLM_PROVIDER).toBe("anthropic");
  expect(config.LLM_MODEL_MAIN).toBeUndefined();
  expect(config.TTS_VOICE_HU_HOST).toBe("hu-HU-NoemiNeural");
});

test("real environment variables win over .env", () => {
  writeEnv("PORT=5050\nHOST=0.0.0.0\n");
  const config = loadConfig({ rootDir: dir, env: { PORT: "6060" } });
  expect(config.PORT).toBe(6060);
  expect(config.HOST).toBe("0.0.0.0");
});

test("bounded Ollama opt-in follows .env precedence through provider construction", () => {
  writeEnv("PROFILE=local\nOLLAMA_BOUNDED_OUTPUT=1\nOLLAMA_BASE_URL=https://ollama.com/v1\n");
  expect(() => createAiSdkLlmProvider(loadConfig({ rootDir: dir, env: {} }), "ollama")).toThrow(/loopback/);
  expect(() => createAiSdkLlmProvider(loadConfig({ rootDir: dir, env: { OLLAMA_BOUNDED_OUTPUT: "0" } }), "ollama")).not.toThrow();
});

test("DATA_DIR is resolved against the root directory, not the working directory", () => {
  expect(loadConfig({ rootDir: dir, env: {} }).DATA_DIR).toBe(path.join(dir, "data"));
  const elsewhere = path.join(dir, "elsewhere");
  expect(loadConfig({ rootDir: dir, env: { DATA_DIR: elsewhere } }).DATA_DIR).toBe(elsewhere);
});

test("rejects an invalid value in .env with a readable message", () => {
  writeEnv("PORT=abc\nPROFILE=hybrid\n");
  let message = "";
  try {
    loadConfig({ rootDir: dir, env: {} });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/^Invalid configuration \(environment and .*\.env\):/);
  expect(message).toMatch(/\nPORT: .*number/);
  expect(message).toMatch(/\nPROFILE: .*cloud.*local/);
  expect(message).not.toMatch(/ZodError|\[\s*\{/); // no raw zod dump
});

test("rejects an invalid environment variable when there is no .env", () => {
  expect(() => loadConfig({ rootDir: dir, env: { MONTHLY_BUDGET_USD: "-5" } })).toThrowError(
    /^Invalid configuration \(environment\):\nMONTHLY_BUDGET_USD: /,
  );
});

test("does not leak secrets into the error message", () => {
  writeEnv("ANTHROPIC_API_KEY=sk-very-secret\nPORT=abc\n");
  expect(() => loadConfig({ rootDir: dir, env: {} })).toThrowError(
    expect.objectContaining({ message: expect.not.stringContaining("sk-very-secret") }),
  );
});
