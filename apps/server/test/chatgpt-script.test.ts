import { expect, it, vi } from "vitest";
import { generatePodcastScript } from "../src/cli/chatgpt-script.ts";
import { generate } from "../src/providers/llm/chatgpt-inference.ts";

const input = {
  lang: "en", mode: "standard",
  plan: { queries: ["a", "b", "c", "d", "e"], angle: "test", targetWordCount: 6 },
  sources: { sources: [1, 2, 3].map((i) => ({ id: `s${i}`, url: "https://example.test", title: "Source", site: "test", text: "fact" })) },
  notes: { facts: [{ sourceId: "s1", text: "fact" }], outline: [{ heading: "Facts", facts: [{ text: "fact", sourceIds: ["s1"] }] }] },
};
const script = {
  title: "Title", summary: "Summary",
  chapters: [1, 2, 3].map((segmentIndex) => ({ title: "Chapter", segmentIndex })),
  segments: ["intro", "content", "content", "content", "recap", "outro"].map((kind) => ({ kind, speaker: "host", lang: "en", text: "word", ...(kind === "content" ? { sourceIds: ["s1"] } : {}) })),
};

it("generates a validated script from prepared research without marking it reviewed", async () => {
  const generateStructured = vi.fn().mockResolvedValue(JSON.stringify(script));
  const result = await generatePodcastScript({ generateStructured }, "model", input);
  expect(result.reviewed).toBe(false);
  expect(result.script.segments[1]).toMatchObject({ id: "seg-0002", sourceIds: ["s1"] });
  expect(generateStructured).toHaveBeenCalledOnce();
});

it("sends structured requests through the bounded streaming transport", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(script) })}\n\ndata: {"type":"response.completed"}\n\n`,
  ));
  const session = { generateStructured: (model: string, system: string, prompt: string, schema: object) =>
    generate("private", model, prompt, { transport, structured: { system, schema } }) };
  const result = await generatePodcastScript(session, "chosen-model", input);
  expect(result.script.title).toBe("Title");
  const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({ model: "chosen-model", store: false, stream: true, text: { format: { type: "json_schema" } } });
  expect(body.input[0].role).toBe("system");
});

it.each([
  ["invalid JSON", "not json"],
  ["unknown citations", JSON.stringify({ ...script, segments: script.segments.map((s) => s.kind === "content" ? { ...s, sourceIds: ["s99"] } : s) })],
  ["wrong length", JSON.stringify({ ...script, segments: script.segments.map((s) => ({ ...s, text: "too many words here" })) })],
])("rejects %s", async (_name, output) => {
  await expect(generatePodcastScript({ generateStructured: async () => output }, "m", input)).rejects.toThrow();
});

it("rejects ungrounded research before inference", async () => {
  const generateStructured = vi.fn();
  await expect(generatePodcastScript({ generateStructured }, "m", { ...input, notes: { ...input.notes, facts: [{ sourceId: "s9", text: "bad" }] } })).rejects.toThrow();
  expect(generateStructured).not.toHaveBeenCalled();
});

it("fails closed when structured output is rejected or streaming is incomplete", async () => {
  for (const response of [new Response("unsupported", { status: 400 }), new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n')]) {
    const session = { generateStructured: (model: string, system: string, prompt: string, schema: object) =>
      generate("private", model, prompt, { transport: async () => response, structured: { system, schema } }) };
    await expect(generatePodcastScript(session, "m", input)).rejects.toThrow();
  }
});
