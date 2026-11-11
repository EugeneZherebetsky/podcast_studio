// Runtime configuration, parsed from a process.env-like object. Keys and defaults mirror
// .env.example. Secrets and model ids are optional here: they are checked when the
// provider that needs them is constructed.
import { z } from "zod";
import { ProfileSchema, type Profile } from "./api.ts";
import { HttpUrlSchema, LangSchema, LevelSchema } from "./episode.ts";
import { formatZodError } from "./errors.ts";

export const LlmProviderNameSchema = z.enum(["anthropic", "openai", "google"]);
export type LlmProviderName = z.infer<typeof LlmProviderNameSchema>;

export const SearchProviderNameSchema = z.enum(["tavily", "brave", "searxng"]);
export type SearchProviderName = z.infer<typeof SearchProviderNameSchema>;

export const TtsProviderNameSchema = z.enum(["azure", "openai", "elevenlabs", "piper"]);
export type TtsProviderName = z.infer<typeof TtsProviderNameSchema>;

/** Provider defaults that depend on the profile; used when the variable is not set. */
export const PROFILE_DEFAULTS: Record<
  Profile,
  { SEARCH_PROVIDER: SearchProviderName; TTS_PROVIDER: TtsProviderName }
> = {
  cloud: { SEARCH_PROVIDER: "tavily", TTS_PROVIDER: "azure" },
  local: { SEARCH_PROVIDER: "searxng", TTS_PROVIDER: "piper" },
};

const optionalString = z.string().optional();

const EnvSchema = z.object({
  PROFILE: ProfileSchema.default("cloud"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4747),
  DATA_DIR: z.string().default("./data"),
  MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(20),

  NATIVE_LANG: LangSchema.default("en"),
  TARGET_LANG: LangSchema.default("hu"),
  LEARNER_LEVEL: LevelSchema.default("A1"),
  /** Lets the local profile run graded/bilingual modes (ARCHITECTURE §5). */
  ALLOW_LOCAL_LEARNING: z.stringbool().default(false),

  // LLM (cloud)
  LLM_PROVIDER: LlmProviderNameSchema.default("anthropic"),
  LLM_MODEL_MAIN: optionalString,
  LLM_MODEL_FAST: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,

  // LLM (local)
  OLLAMA_BASE_URL: HttpUrlSchema.default("http://localhost:11434/v1"),
  OLLAMA_MODEL_MAIN: z.string().default("qwen3.5:4b"),
  OLLAMA_MODEL_FAST: z.string().default("qwen3.5:4b"),

  // Search
  SEARCH_PROVIDER: SearchProviderNameSchema.optional(),
  TAVILY_API_KEY: optionalString,
  BRAVE_API_KEY: optionalString,
  SEARXNG_URL: HttpUrlSchema.default("http://localhost:8888"),

  // Text to speech
  TTS_PROVIDER: TtsProviderNameSchema.optional(),
  AZURE_SPEECH_KEY: optionalString,
  AZURE_SPEECH_REGION: z.string().default("westeurope"),
  TTS_VOICE_HU_HOST: z.string().default("hu-HU-NoemiNeural"),
  TTS_VOICE_HU_COHOST: z.string().default("hu-HU-TamasNeural"),
  TTS_VOICE_NATIVE_HOST: optionalString,
  TTS_VOICE_NATIVE_TEACHER: optionalString,
  ELEVENLABS_API_KEY: optionalString,
  PIPER_DIR: z.string().default("./infra/piper"),
});

/** `KEY=` lines in .env arrive as empty strings: treat them, and undefined, as not set. */
function dropBlankValues(env: unknown): unknown {
  if (typeof env !== "object" || env === null || Array.isArray(env)) return env;
  return Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) => value !== undefined && !(typeof value === "string" && value.trim() === ""),
    ),
  );
}

/**
 * Parses a process.env-like object. Unknown variables are ignored. `SEARCH_PROVIDER` and
 * `TTS_PROVIDER` default by profile (cloud: tavily + azure, local: searxng + piper); an
 * explicitly set value always wins.
 */
export const ConfigSchema = z.preprocess(dropBlankValues, EnvSchema).transform((env) => ({
  ...env,
  SEARCH_PROVIDER: env.SEARCH_PROVIDER ?? PROFILE_DEFAULTS[env.PROFILE].SEARCH_PROVIDER,
  TTS_PROVIDER: env.TTS_PROVIDER ?? PROFILE_DEFAULTS[env.PROFILE].TTS_PROVIDER,
}));
export type AppConfig = z.infer<typeof ConfigSchema>;

/** Parses the environment or throws one error listing every invalid variable. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${formatZodError(result.error)}`);
  }
  return result.data;
}
