import { expect, it } from "vitest";
import { listModels, generate } from "../src/providers/llm/chatgpt-inference.ts";

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
