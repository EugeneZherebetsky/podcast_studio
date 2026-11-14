// Real-API smoke checks for providers (run with `pnpm smoke`).
import { parseArgs } from "node:util";
import { parseConfig } from "shared";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import {
  createLlmProvider,
  createSearchProvider,
  createTtsProvider,
  SearxngSearchProvider,
} from "../providers/index.ts";
import { createAiSdkLlmProvider, findLlmApiKey } from "../providers/llm/ai-sdk.ts";

const TinySchema = z.object({
  greeting: z.string(),
  language: z.string(),
});

async function runLlmSmoke(): Promise<void> {
  const config = loadConfig();

  console.log("=== LLM Provider Smoke Check ===");

  // 1. Cloud provider check (from active .env / config)
  if (config.PROFILE === "cloud") {
    const key = findLlmApiKey(config, config.LLM_PROVIDER);
    if (!key) {
      console.log(`[cloud: configured] skipped: no API key set in .env`);
    } else if (!config.LLM_MODEL_MAIN || !config.LLM_MODEL_FAST) {
      console.log(
        `[cloud: configured] skipped: LLM_MODEL_MAIN or LLM_MODEL_FAST not set in .env`,
      );
    } else {
      try {
        console.log(
          `[cloud: configured] calling fast slot...`,
        );
        const provider = createLlmProvider(config);
        await provider.generateObject({
          slot: "fast",
          system: "Be extremely concise. Return JSON matching the schema.",
          prompt: "Say hello in English.",
          schema: TinySchema,
        });
        console.log(`[cloud: configured] SUCCESS`);
      } catch {
        console.error(`[cloud: configured] FAILED`);
      }
    }
  } else {
    console.log(`[cloud] skipped: current profile is local`);
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
      `[local: ollama] calling fast slot...`,
    );
    await ollamaProvider.generateObject({
      slot: "fast",
      system: "Be extremely concise. Return JSON matching the schema.",
      prompt: "Say hello.",
      schema: TinySchema,
    });
    console.log("[local: ollama] SUCCESS");
  } catch {
    console.error("[local: ollama] FAILED");
  }
}

async function runSearchSmoke(): Promise<void> {
  const config = loadConfig();
  console.log("=== Search Provider Smoke Check ===");

  // 1. Configured search provider check
  if (config.SEARCH_PROVIDER === "tavily") {
    if (!config.TAVILY_API_KEY) {
      console.log("[search: tavily] skipped: no API key set in .env");
    } else {
      try {
        console.log('[search: tavily] searching for "podcast"...');
        const provider = createSearchProvider(config);
        const hits = await provider.search("podcast", { max: 3 });
        console.log(`[search: tavily] SUCCESS: returned ${hits.length} hit(s):`);
      } catch {
        console.error("[search: tavily] FAILED");
      }
    }
  } else if (config.SEARCH_PROVIDER === "brave") {
    if (!config.BRAVE_API_KEY) {
      console.log("[search: brave] skipped: no API key set in .env");
    } else {
      try {
        console.log('[search: brave] searching for "podcast"...');
        const provider = createSearchProvider(config);
        const hits = await provider.search("podcast", { max: 3 });
        console.log(`[search: brave] SUCCESS: returned ${hits.length} hit(s):`);
      } catch {
        console.error("[search: brave] FAILED");
      }
    }
  }

  // 2. SearXNG check (local profile or local container)
  const searxngUrl = config.SEARXNG_URL || "http://localhost:8888";
  console.log("\n[search: searxng] checking local SearXNG...");
  try {
    const searxng = new SearxngSearchProvider({ baseUrl: searxngUrl });
    const hits = await searxng.search("podcast", { max: 3 });
    console.log(`[search: searxng] SUCCESS: returned ${hits.length} hit(s):`);
  } catch {
    console.log("[search: searxng] unreachable/skipped");
  }
}

async function runTtsSmoke(): Promise<void> {
  const config = loadConfig();
  console.log("=== TTS Provider Smoke Check ===");

  const providerName = config.TTS_PROVIDER;
  if (providerName === "azure") {
    if (!config.AZURE_SPEECH_KEY) {
      console.log(`[tts: ${providerName}] skipped: no API key in .env`);
      return;
    }
  } else if (providerName === "openai") {
    if (!config.OPENAI_API_KEY) {
      console.log(`[tts: ${providerName}] skipped: no API key in .env`);
      return;
    }
  } else {
    console.log(`[tts] skipped: provider not supported in smoke check`);
    return;
  }

  try {
    const provider = createTtsProvider(config);
    const enVoice =
      providerName === "azure"
        ? config.TTS_VOICE_NATIVE_HOST || "en-US-JennyNeural"
        : "alloy";
    const huVoice =
      providerName === "azure" ? config.TTS_VOICE_HU_HOST : "alloy";

    console.log(`[tts: ${providerName}] synthesising English greeting...`);
    await provider.synthesize({
      text: "Hello! Welcome to Podcast Studio.",
      lang: "en",
      voice: enVoice,
      rate: 1,
    });
    console.log(`[tts: ${providerName}] SUCCESS (en)`);

    console.log(`[tts: ${providerName}] synthesising Hungarian greeting...`);
    await provider.synthesize({
      text: "Szervusz! Üdvözöllek a Podcast Stúdióban.",
      lang: "hu",
      voice: huVoice,
      rate: 1,
    });
    console.log(`[tts: ${providerName}] SUCCESS (hu)`);
  } catch {
    console.error(`[tts: ${providerName}] FAILED`);
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

  if (only && only !== "llm" && only !== "search" && only !== "tts") {
    console.log(`smoke: unknown target`);
    return;
  }

  if (!only || only === "llm") {
    await runLlmSmoke();
  }
  if (!only || only === "search") {
    if (!only) console.log("");
    await runSearchSmoke();
  }
  if (!only || only === "tts") {
    if (!only) console.log("");
    await runTtsSmoke();
  }
}

main().catch(() => {
  console.error("smoke command failed");
  process.exit(1);
});
