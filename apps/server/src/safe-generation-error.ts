import { ChatGptCancelledError, ChatGptTimeoutError } from "./providers/llm/chatgpt-inference.ts";
import { usageOfFailedCall, type Usage } from "./providers/llm/interface.ts";

export class CloudTtsBillingUncertain extends Error {
  constructor() { super("Cloud TTS failed; the provider may have billed this request"); }
}

const recovery = "external work may still be running; stop the server and follow manual recovery in SETUP.md";
const classifications = [
  "Generation timed out",
  "Generation cancelled",
  "ChatGPT request timed out; remote work may still be running",
  "ChatGPT request cancelled; remote work may still be running",
  "Cloud TTS failed; the provider may have billed this request",
];
export const combinedRecoveryMessages: readonly string[] = Object.freeze(classifications.map((message) => `${message}; ${recovery}`));
const wrappedMessages = new WeakMap<ExternalWorkUncertain, string>();
const wrappedUsage = new WeakMap<ExternalWorkUncertain, Usage>();
export class ExternalWorkUncertain extends Error {
  get usage(): Usage | undefined { return wrappedUsage.get(this); }
  constructor(error: unknown) {
    super("External work uncertain");
    const usage = usageOfFailedCall(error);
    if (usage) wrappedUsage.set(this, { provider: usage.provider, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
    const message = safeGenerationError(error);
    const index = classifications.indexOf(message);
    wrappedMessages.set(this, error instanceof ExternalWorkUncertain ? message : index < 0 ? `External work may still be running; stop the server and follow manual recovery in SETUP.md` : combinedRecoveryMessages[index]!);
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
    if (error.name === "TimeoutError") return "Generation timed out";
    if (error.name === "AbortError") return "Generation cancelled";
    if (SAFE_MESSAGES.has(error.message)) return error.message;
  }
  return "Generation failed";
}
