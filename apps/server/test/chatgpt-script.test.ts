import { expect, it, vi } from "vitest";
import { generatePodcastScript } from "../src/cli/chatgpt-script.ts";
import { generate } from "../src/providers/llm/chatgpt-inference.ts";
import { runScriptStage } from "../src/pipeline/script.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeLlmProvider } from "../src/providers/llm/fake.ts";
import { generateJob } from "../src/pipeline/runner.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";

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

it("passes selected script generation through the runner and still reviews it", async () => {
  const f = fakeGeneration({ review: true });
  try {
    const generateStructured = vi.fn(async () => JSON.stringify({ ...script, segments: script.segments.map((s) => ({ ...s, text: Array(23).fill("bees").join(" ") })) }));
    const run = vi.fn(async (research: Parameters<typeof runScriptStage>[1]) =>
      (await generatePodcastScript({ generateStructured }, "chosen-model", research)).script,
    );
    await generateJob({ ...f.deps, scriptGenerator: { identity: "test:chosen", run } }, f.jobId);
    expect(run).toHaveBeenCalledOnce();
    expect(f.stageStatus("review")).toBe("done");
    expect(f.llm.stages).toContain("review");
    expect(f.llm.stages).not.toContain("script");
    expect(f.job().status).toBe("succeeded");
  } finally {
    f.close();
  }
}, GENERATION_TIMEOUT_MS);

it("rejects a selected generator result that cites an unbacked source", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "chatgpt-invalid-"));
  try {
    const bad = { ...script, segments: script.segments.map((s, i) => ({ ...s, id: `seg-${i}`, sourceIds: s.kind === "content" ? ["s2"] : undefined })) };
    await expect(runScriptStage({ workDir, llm: new FakeLlmProvider(), scriptGenerator: { identity: "test", run: async () => bad as Awaited<ReturnType<typeof generatePodcastScript>>["script"] } }, input as Parameters<typeof runScriptStage>[1])).rejects.toThrow(/source|research/i);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

it("runs the explicit ChatGPT script stage and separates its cache from local generation", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "chatgpt-stage-"));
  try {
    const generateStructured = vi.fn().mockResolvedValue(JSON.stringify(script));
    const llm = new FakeLlmProvider();
    const typedInput = input as Parameters<typeof runScriptStage>[1];
    const selected = { identity: "chatgpt:chosen-model", run: async () => (await generatePodcastScript({ generateStructured }, "chosen-model", input)).script };
    const first = await runScriptStage({ workDir, llm, scriptGenerator: selected }, typedInput);
    expect(first.artifact.segments[1]?.sourceIds).toEqual(["s1"]);
    expect(first.skipped).toBe(false);
    const cached = await runScriptStage({ workDir, llm, scriptGenerator: selected }, typedInput);
    expect(cached.skipped).toBe(true);
    expect(generateStructured).toHaveBeenCalledOnce();
    const different = { ...selected, identity: "chatgpt:other-model" };
    expect((await runScriptStage({ workDir, llm, scriptGenerator: different }, typedInput)).skipped).toBe(false);
    expect(generateStructured).toHaveBeenCalledTimes(2);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

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
  expect(body.instructions).toBeTruthy();
  expect(body.input.every((item: { role: string }) => item.role !== "system")).toBe(true);
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
