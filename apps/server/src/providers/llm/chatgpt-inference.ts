type Options = {
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
  consume: (text: string) => T,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("Request cancelled or timed out"));
    else
      signal.addEventListener("abort", () => reject(new Error("Request cancelled or timed out")), {
        once: true,
      });
  });
  try {
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
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > (options.maxBytes ?? 1_000_000)) throw new Error("Response exceeds byte limit");
      chunks.push(part.value);
    }
    return consume(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (reader) void reader.cancel().catch(() => {});
    controller.abort();
    if (
      error instanceof Error &&
      ["Response exceeds byte limit", "Request cancelled or timed out"].includes(error.message)
    )
      throw error;
    // Do not attach the original error: transports may include authorization details.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("ChatGPT request failed or response was invalid");
  } finally {
    clearTimeout(timeout);
  }
}

export async function listModels(token: string, options: Options = {}) {
  return request(token, "models", undefined, options, (text) => {
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
  });
}

export async function generate(
  token: string,
  model: string,
  prompt: string,
  options: Options = {},
) {
  if (!model.trim() || !prompt.trim()) throw new Error("Model and prompt are required");
  return request(
    token,
    "responses",
    {
      model,
      input: [
        ...(options.structured ? [{ role: "system", content: options.structured.system }] : []),
        { role: "user", content: prompt },
      ],
      store: false, stream: true,
      ...(options.structured ? { text: { format: { type: "json_schema", name: "podcast_script", strict: false, schema: options.structured.schema } } } : {}),
    },
    options,
    (text) => {
      if (!/\r?\n\r?\n$/.test(text)) throw new Error("Incomplete stream framing");
      let output = "";
      let completed = false;
      for (const event of text.split(/\r?\n\r?\n/)) {
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
      }
      if (!completed) throw new Error("Incomplete response");
      return output;
    },
  );
}
