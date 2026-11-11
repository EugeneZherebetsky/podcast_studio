// Real-API smoke checks for providers (run with `pnpm smoke`).
import { parseArgs } from "node:util";
import { parseConfig } from "shared";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { createLlmProvider, selectProviderNames } from "../providers/index.ts";
import { createAiSdkLlmProvider, findLlmApiKey } from "../providers/llm/ai-sdk.ts";

const TinySchema = z.object({
  greeting: z.string(),
  language: z.string(),
});

async function runLlmSmoke(): Promise<void> {
  const config = loadConfig();
  const names = selectProviderNames(config);

  console.log("=== LLM Provider Smoke Check ===");

  // 1. Cloud provider check (from active .env / config)
  if (config.PROFILE === "cloud") {
    const key = findLlmApiKey(config, config.LLM_PROVIDER);
    if (!key) {
      console.log(`[cloud: ${names.llm}] skipped: no API key set in .env`);
    } else if (!config.LLM_MODEL_MAIN || !config.LLM_MODEL_FAST) {
      console.log(
        `[cloud: ${names.llm}] skipped: LLM_MODEL_MAIN or LLM_MODEL_FAST not set in .env`,
      );
    } else {
      try {
        console.log(
          `[cloud: ${names.llm}] calling ${config.LLM_MODEL_FAST} (slot: fast)...`,
        );
        const provider = createLlmProvider(config);
        const result = await provider.generateObject({
          slot: "fast",
          system: "Be extremely concise. Return JSON matching the schema.",
          prompt: "Say hello in English.",
          schema: TinySchema,
        });
        console.log(`[cloud: ${names.llm}] SUCCESS:`, result.object);
        console.log(`[cloud: ${names.llm}] Usage:`, result.usage);
      } catch (err) {
        console.error(`[cloud: ${names.llm}] FAILED:`, (err as Error).message);
      }
    }
  } else {
    console.log(`[cloud] skipped: current profile is "${config.PROFILE}"`);
  }

  // 2. Ollama local provider check
  console.log("\n[local: ollama] checking local Ollama model...");
  try {
    const localConfig = parseConfig({
      PROFILE: "local",
      OLLAMA_BASE_URL: config.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      OLLAMA_MODEL_MAIN: config.OLLAMA_MODEL_MAIN || "qwen3.5:4b",
      OLLAMA_MODEL_FAST: config.OLLAMA_MODEL_FAST || "qwen3.5:4b",
    });
    const ollamaProvider = createAiSdkLlmProvider(localConfig, "ollama");
    console.log(
      `[local: ollama] calling ${localConfig.OLLAMA_MODEL_FAST} at ${localConfig.OLLAMA_BASE_URL}...`,
    );
    const result = await ollamaProvider.generateObject({
      slot: "fast",
      system: "Be extremely concise. Return JSON matching the schema.",
      prompt: "Say hello.",
      schema: TinySchema,
    });
    console.log("[local: ollama] SUCCESS:", result.object);
    console.log("[local: ollama] Usage:", result.usage);
  } catch (err) {
    console.error("[local: ollama] FAILED:", (err as Error).message);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      only: { type: "string" },
    },
    strict: false,
  });

  const only = values.only as string | undefined;

  if (only && only !== "llm") {
    if (only === "search") {
      console.log("smoke --only search: not implemented yet (T06)");
      return;
    }
    if (only === "tts") {
      console.log("smoke --only tts: not implemented yet (T10)");
      return;
    }
    console.log(`smoke --only ${only}: unknown target`);
    return;
  }

  await runLlmSmoke();
}

main().catch((err) => {
  console.error("smoke command failed:", err);
  process.exit(1);
});
