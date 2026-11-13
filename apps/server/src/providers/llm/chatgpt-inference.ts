export type RequestProgress = { bytes: number; events: number; elapsedMs: number };
export type GenerateOptions = { timeoutMs?: number; onProgress?: (progress: RequestProgress) => void };
export class ChatGptTimeoutError extends Error {
  constructor() { super("ChatGPT request timed out; remote work may still be running"); }
}
export class ChatGptCancelledError extends Error {
  constructor() { super("ChatGPT request cancelled; remote work may still be running"); }
}
type Options = GenerateOptions & {
  transport?: typeof fetch;
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  structured?: { system: string; schema: object };
};

async function request<T>(
  token: string,
  endpoint: string,
  body: object | undefined,
  options: Options,
  consume: { push(text: string): void | boolean; finish(): T },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new Error("Invalid ChatGPT request timeout");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.aborted ? new ChatGptTimeoutError() : new ChatGptCancelledError());
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) return await aborted;
    const response = await Promise.race([
      (options.transport ?? fetch)(`https://api.openai.com/v1/${endpoint}`, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      aborted,
    ]);
    if (!response.ok || response.status >= 300 || !response.body) throw new Error("Request failed");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > (options.maxBytes ?? 1_000_000)) throw new Error("Response exceeds byte limit");
      if (consume.push(decoder.decode(part.value, { stream: true }))) {
        consume.push(decoder.decode());
        const result = consume.finish();
        void reader.cancel().catch(() => {});
        return result;
      }
    }
    consume.push(decoder.decode());
    return consume.finish();
  } catch (error) {
    if (reader) void reader.cancel().catch(() => {});
    if (error instanceof ChatGptTimeoutError || error instanceof ChatGptCancelledError ||
      (error instanceof Error && error.message === "Response exceeds byte limit")) throw error;
    // Do not attach the original error: transports may include authorization details.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("ChatGPT request failed or response was invalid");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export async function listModels(token: string, options: Options = {}) {
  let text = "";
  return request(token, "models", undefined, options, { push(chunk) { text += chunk; }, finish() {
    const data = JSON.parse(text) as {
      models: { visibility: string; slug: string; display_name: string }[];
    };
    if (!Array.isArray(data.models)) throw new Error("Invalid catalog");
    return data.models
      .filter(
        (m) =>
          m.visibility === "list" &&
          typeof m.slug === "string" &&
          typeof m.display_name === "string",
      )
      .map(({ slug, display_name }) => ({ slug, display_name }));
  } });
}

export async function generate(
  token: string,
  model: string,
  prompt: string,
  options: Options = {},
) {
  if (!model.trim() || !prompt.trim()) throw new Error("Model and prompt are required");
  let buffer = "", output = "", completed = false, bytes = 0, events = 0;
  const started = Date.now();
  let lastProgress = started - 5_000;
  return request(
    token,
    "responses",
    {
      model,
      ...(options.structured ? { instructions: options.structured.system } : {}),
      input: [{ role: "user", content: prompt }],
      store: false, stream: true,
      ...(options.structured ? { text: { format: { type: "json_schema", name: "podcast_script", strict: false, schema: options.structured.schema } } } : {}),
    },
    options,
    { push(chunk) {
      buffer += chunk;
      bytes += Buffer.byteLength(chunk);
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const value = JSON.parse(data) as { type?: string; delta?: unknown };
        if (
          value.type === "response.failed" ||
          value.type === "response.incomplete" ||
          value.type === "error"
        )
          throw new Error("Inference failed");
        if (value.type === "response.output_text.delta") {
          if (typeof value.delta !== "string" || completed) throw new Error("Invalid delta");
          output += value.delta;
        }
        if (value.type === "response.completed") completed = true;
        events++;
      }
      const now = Date.now();
      if (events && now - lastProgress >= 5_000) {
        options.onProgress?.({ bytes, events, elapsedMs: now - started });
        lastProgress = now;
      }
      return completed;
    }, finish() {
      if (buffer || !completed) throw new Error("Incomplete response");
      return output;
    } },
  );
}
