import { expect, it, vi } from "vitest";
import { listModels, generate, ChatGptTimeoutError, ChatGptCancelledError } from "../src/providers/llm/chatgpt-inference.ts";

it("lists visible models and sends a bounded streaming request", async () => {
  const calls: RequestInit[] = [];
  const transport: typeof fetch = async (_url, init) => {
    calls.push(init!);
    return calls.length === 1
      ? Response.json({
          models: [
            { slug: "m", display_name: "Model", visibility: "list" },
            { visibility: "hidden" },
          ],
        })
      : new Response(
          'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed"}\n\n',
        );
  };
  expect(await listModels("secret", { transport })).toEqual([{ slug: "m", display_name: "Model" }]);
  expect(await generate("secret", "m", "hi", { transport })).toBe("hello");
  expect(JSON.parse(calls[1]!.body as string)).toEqual({
    model: "m",
    input: [{ role: "user", content: "hi" }],
    store: false,
    stream: true,
  });
  expect(calls[1]!.redirect).toBe("error");
});

it.each([
  [
    "redirect",
    () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
  ],
  ["http error", () => new Response("secret", { status: 401 })],
  ["incomplete", () => new Response('data: {"type":"response.incomplete"}\n\n')],
  ["failed", () => new Response('data: {"type":"response.failed"}\n\n')],
  [
    "interrupted",
    () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
  ],
  ["oversized", () => new Response("x".repeat(100))],
])("rejects %s without leaking credentials", async (_name, response) => {
  const transport: typeof fetch = async () => response();
  await expect(
    generate("sensitive-token", "m", "p", { transport, maxBytes: 90 }),
  ).rejects.toThrow();
  try {
    await generate("sensitive-token", "m", "p", { transport, maxBytes: 90 });
  } catch (error) {
    expect(String(error)).not.toContain("sensitive-token");
  }
});

it("reports content-free incremental progress while a request lasts over 60 seconds", async () => {
  vi.useFakeTimers();
  try {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const transport: typeof fetch = async () => new Response(new ReadableStream({ start(c) { stream = c; } }));
    const progress = vi.fn();
    const pending = generate("token", "m", "p", { transport, timeoutMs: 300_000, onProgress: progress });
    await vi.advanceTimersByTimeAsync(65_000);
    stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"private content"}\n\n'));
    await vi.advanceTimersByTimeAsync(1);
    expect(progress).toHaveBeenCalled();
    expect(JSON.stringify(progress.mock.calls)).not.toContain("private content");
    stream.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
    stream.close();
    await expect(pending).resolves.toBe("private content");
  } finally { vi.useRealTimers(); }
});

it("throttles stream progress and handles frames split across chunks", async () => {
  vi.useFakeTimers();
  try {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const transport: typeof fetch = async () => new Response(new ReadableStream({ start(c) { stream = c; } }));
    const progress = vi.fn();
    const result = generate("token", "m", "p", { transport, timeoutMs: 100_000, onProgress: progress });
    await vi.advanceTimersByTimeAsync(0);
    const frame = 'data: {"type":"response.output_text.delta","delta":"private"}\n\n';
    const encoder = new TextEncoder();
    stream.enqueue(encoder.encode(frame.slice(0, 25)));
    stream.enqueue(encoder.encode(frame.slice(25)));
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledTimes(1);
    stream.enqueue(encoder.encode(frame));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(progress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    stream.enqueue(encoder.encode(frame));
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledTimes(2);
    stream.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
    stream.close();
    await expect(result).resolves.toBe("privateprivateprivate");
    expect(JSON.stringify(progress.mock.calls)).not.toContain("private");
  } finally { vi.useRealTimers(); }
});

it("bounds a stalled active stream and distinguishes user cancellation", async () => {
  vi.useFakeTimers();
  try {
    const transport: typeof fetch = async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"private"}\n\n'));
    } }));
    const pending = generate("token", "m", "p", { transport, timeoutMs: 300_000 });
    const timedOut = expect(pending).rejects.toBeInstanceOf(ChatGptTimeoutError);
    await vi.advanceTimersByTimeAsync(300_000);
    await timedOut;
    const controller = new AbortController();
    const cancelled = generate("token", "m", "p", { transport, signal: controller.signal });
    const assertion = expect(cancelled).rejects.toBeInstanceOf(ChatGptCancelledError);
    controller.abort();
    await assertion;
  } finally { vi.useRealTimers(); }
});

it("rejects malformed split frames and does not leak their content", async () => {
  const transport: typeof fetch = async () => new Response('data: {"secret":"private"\n\n');
  await expect(generate("token", "m", "p", { transport })).rejects.toThrow("response was invalid");
});

it("aborts stalled requests on timeout and cancellation", async () => {
  const transport: typeof fetch = async () => new Promise(() => {});
  await expect(generate("token", "m", "p", { transport, timeoutMs: 5 })).rejects.toThrow(
    "timed out",
  );
  const controller = new AbortController();
  const result = generate("token", "m", "p", { transport, signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toThrow("cancelled");
});
