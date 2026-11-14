import { ChatGptCancelledError, ChatGptTimeoutError } from "./providers/llm/chatgpt-inference.ts";
import { usageOfFailedCall, type Usage } from "./providers/llm/interface.ts";

export class CloudTtsBillingUncertain extends Error {
  constructor() { super("Cloud TTS failed; the provider may have billed this request"); }
}

const wrappedMessages = new WeakMap<ExternalWorkUncertain, string>();
export class ExternalWorkUncertain extends Error {
  readonly usage: Usage | undefined;
  constructor(error: unknown) {
    super("External work uncertain", { cause: error });
    this.usage = usageOfFailedCall(error);
    const message = safeGenerationError(error);
    wrappedMessages.set(this, message === "Generation failed" ? "External work may still be running; stop the server and follow manual recovery in SETUP.md" : message);
  }
}

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
  if (error instanceof ExternalWorkUncertain) return wrappedMessages.get(error) ?? "Generation failed";
  if (error instanceof CloudTtsBillingUncertain) return "Cloud TTS failed; the provider may have billed this request";
  if (error instanceof ChatGptTimeoutError) return "ChatGPT request timed out; remote work may still be running";
  if (error instanceof ChatGptCancelledError) return "ChatGPT request cancelled; remote work may still be running";
  if (error instanceof Error) {
    if (SAFE_MESSAGES.has(error.message)) return error.message;
    if (error.name === "TimeoutError") return "Generation timed out";
    if (error.name === "AbortError") return "Generation cancelled";
  }
  return "Generation failed";
}
