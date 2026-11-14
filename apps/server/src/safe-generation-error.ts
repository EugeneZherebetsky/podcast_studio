// Only fixed strings are safe to persist or broadcast for unknown exceptions.
const SAFE_MESSAGES = new Set([
  "Cloud TTS input limit exceeded",
  "Invalid cloud TTS input limit",
  "Monthly budget exceeded",
  "Invalid budget",
  "Invalid recorded spending",
  "Job ownership lost",
  "Invalid ChatGPT stage timeout",
  "Selection changed before generation",
  "Script selection changed before generation",
  "ChatGPT returned invalid structured output after two attempts",
  "network unavailable",
  "publish failed",
]);

export function safeGenerationError(error: unknown): string {
  if (error instanceof Error) {
    if (SAFE_MESSAGES.has(error.message)) return error.message;
    if (error.message === "ChatGPT request timed out; remote work may still be running") return error.message;
    if (error.name === "TimeoutError") return "Generation timed out";
    if (error.name === "AbortError") return "Generation cancelled";
  }
  return "Generation failed";
}
