import { formatZodError } from "shared";
import type {
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmProvider,
  Usage,
} from "./interface.ts";

export type FakeLlmCall = GenerateObjectRequest<unknown>;

/** A scripted response: the object itself, or a function that builds it from the call. */
export type FakeLlmResponse =
  ((call: FakeLlmCall) => unknown) | object | string | number | boolean | null;

export interface FakeLlmOptions {
  /** Responses handed out in order, one per `generateObject` call. */
  responses?: readonly FakeLlmResponse[];
}

/**
 * Scripted LLM for tests. Each call takes the next queued response, validates it against
 * the schema of that call (throwing if it does not match) and is recorded in `calls` so
 * tests can assert on prompts. To return a function as the object, wrap it in another one.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly calls: FakeLlmCall[] = [];
  private readonly queue: FakeLlmResponse[];

  constructor(options: FakeLlmOptions = {}) {
    this.queue = [...(options.responses ?? [])];
  }

  /** Adds responses to the end of the queue. */
  enqueue(...responses: FakeLlmResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  /** Number of queued responses not yet consumed. */
  get pending(): number {
    return this.queue.length;
  }

  /** Forgets recorded calls and queued responses. */
  reset(): void {
    this.calls.length = 0;
    this.queue.length = 0;
  }

  async generateObject<T>(request: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
    const call: FakeLlmCall = request;
    this.calls.push(call);
    const callNumber = this.calls.length;
    if (this.queue.length === 0) {
      throw new Error(
        `FakeLlmProvider: no response queued for call #${callNumber} (slot "${request.slot}")`,
      );
    }
    const next = this.queue.shift();
    const candidate: unknown = typeof next === "function" ? next(call) : next;

    const result = request.schema.safeParse(candidate);
    if (!result.success) {
      throw new Error(
        `FakeLlmProvider: response for call #${callNumber} does not match the schema:\n` +
          formatZodError(result.error),
      );
    }
    return { object: result.data, usage: fakeUsage(request, result.data) };
  }
}

/** Free, and derived only from the call, so cost-guard tests get stable numbers. */
function fakeUsage(request: FakeLlmCall, object: unknown): Usage {
  const tokens = (text: string) => Math.ceil(text.length / 4);
  return {
    provider: "fake",
    model: `fake-${request.slot}`,
    inputTokens: tokens(request.system) + tokens(request.prompt),
    outputTokens: tokens(JSON.stringify(object) ?? ""),
    costUsd: 0,
  };
}
