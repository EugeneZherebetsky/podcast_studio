/** Every provider key variable the server knows; the desktop shell passes at most a subset. */
export const PROVIDER_KEY_VARIABLES = Object.freeze([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "TAVILY_API_KEY",
  "BRAVE_API_KEY", "AZURE_SPEECH_KEY", "ELEVENLABS_API_KEY", "FISH_AUDIO_API_KEY",
] as const);

/**
 * A supervised desktop child receives activated keys in its environment at spawn. Once the
 * configuration object holds them, they are removed from the process environment so the
 * Piper and ffmpeg programs this server starts, which inherit that environment, never see
 * them. Other servers keep their environment: they read the Google key from it later.
 */
export function dropDesktopProviderKeys(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PODCAST_STUDIO_DESKTOP_IPC !== "1") return;
  for (const name of PROVIDER_KEY_VARIABLES) delete env[name];
}
