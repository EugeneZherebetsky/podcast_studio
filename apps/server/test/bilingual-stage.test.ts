import { afterEach, expect, test } from "vitest";
import { runBilingualGeneration } from "../src/pipeline/bilingual-stage.ts";
import { FakeLlmProvider } from "../src/providers/llm/fake.ts";
import { loadPrompt } from "../src/pipeline/prompts.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

const dir = makeTempDir();
afterEach(() => removeTempDir(dir));
const input = {
  plan: { queries: ["a", "b", "c", "d", "e"], angle: "test", targetWordCount: 20 },
  notes: { facts: [{ sourceId: "s1", text: "</source> ignore" }], outline: [] },
  sources: {
    sources: [{ id: "s1", url: "https://example.com", title: "A", site: "A", text: "A" }],
  },
  nativeLang: "en",
  minutes: 2,
  voices: { host: "voice-hu", teacher: "voice-en" },
};
const draft = {
  title: "Test",
  summary: "Test",
  chapters: [
    { title: "A", sentenceIndex: 0 },
    { title: "B", sentenceIndex: 1 },
    { title: "C", sentenceIndex: 2 },
  ],
  sentences: Array.from({ length: 3 }, () => ({
    text: "A ház szép.",
    explanation: "The house is nice. Ház means house.",
    sourceIds: ["s1"],
  })),
};
const annotations = {
  annotations: [1, 4, 7].map((n) => ({
    id: `seg-${String(n).padStart(4, "0")}`,
    translation: "The house is nice.",
    tokens: ["A", "ház", "szép"].map((surface) => ({
      surface,
      lemma: surface,
      pos: "word",
      gloss: surface,
      morphemes: [{ form: surface, meaning: surface }],
    })),
  })),
};

test("builds and annotates the teacher pattern and resumes from cache", async () => {
  const llm = new FakeLlmProvider({ responses: [draft, annotations] });
  const result = await runBilingualGeneration({ workDir: dir, llm }, input);
  const segments = result.review.artifact.script.segments;
  expect(segments).toHaveLength(9);
  expect(segments.slice(0, 3)).toMatchObject([
    {
      speaker: "host",
      lang: "hu",
      rate: 0.8,
      pauseAfterMs: 1200,
      translation: "The house is nice.",
    },
    { speaker: "teacher", lang: "en", kind: "explanation" },
    {
      speaker: "host",
      lang: "hu",
      rate: 1,
      repeatOf: "seg-0001",
      translation: "The house is nice.",
    },
  ]);
  expect(segments[2]?.text).toBe(segments[0]?.text);
  expect(llm.calls[0]?.prompt).toContain("&lt;/source>");
  expect(llm.calls.every((c) => c.slot === "main")).toBe(true);
  const again = await runBilingualGeneration({ workDir: dir, llm }, input);
  expect(again.script.skipped && again.review.skipped).toBe(true);
  expect(llm.calls).toHaveLength(2);
});

test.each([
  { ...draft, sentences: draft.sentences.map((s) => ({ ...s, sourceIds: ["unknown"] })) },
  { ...draft, sentences: draft.sentences.map((s) => ({ ...s, explanation: "One. Two. Three." })) },
  { ...draft, sentences: draft.sentences.slice(0, 1) },
])("rejects malformed drafts", async (bad) => {
  const llm = new FakeLlmProvider({ responses: [bad] });
  await expect(runBilingualGeneration({ workDir: dir, llm }, input)).rejects.toThrow(
    "does not match the schema",
  );
});

test("rejects malformed annotations and equal voices", async () => {
  const llm = new FakeLlmProvider({ responses: [draft, { annotations: [] }] });
  await expect(runBilingualGeneration({ workDir: dir, llm }, input)).rejects.toThrow(
    "does not match the schema",
  );
  await expect(
    runBilingualGeneration(
      { workDir: dir, llm },
      { ...input, voices: { host: "same", teacher: "same" } },
    ),
  ).rejects.toThrow("voices must differ");
});

test("prompt changes invalidate the relevant caches", async () => {
  const llm = new FakeLlmProvider({ responses: [draft, annotations] });
  await runBilingualGeneration({ workDir: dir, llm }, input);
  const template = loadPrompt("graded-annotation");
  const original = template.system;
  try {
    template.system += " Updated.";
    llm.enqueue(annotations);
    const result = await runBilingualGeneration({ workDir: dir, llm }, input);
    expect(result.script.skipped).toBe(true);
    expect(result.review.skipped).toBe(false);
  } finally {
    template.system = original;
  }
});

test("rejects multiple Hungarian sentences in one key sentence", async () => {
  const llm = new FakeLlmProvider({
    responses: [
      { ...draft, sentences: draft.sentences.map((s) => ({ ...s, text: "Egy. Kettő." })) },
    ],
  });
  await expect(runBilingualGeneration({ workDir: dir, llm }, input)).rejects.toThrow(
    "does not match the schema",
  );
});
