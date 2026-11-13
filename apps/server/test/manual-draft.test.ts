import { expect, test } from "vitest";
import { prepareManualDraft, parseManualDraft } from "../src/pipeline/manual-draft.ts";

const input = {
  plan: { queries: ["a", "b", "c", "d", "e"], angle: "Bees", targetWordCount: 18 },
  notes: {
    facts: [{ sourceId: "s1", text: "Bees fly." }],
    outline: [{ heading: "Bees", facts: [{ text: "Bees fly.", sourceIds: ["s1"] }] }],
  },
  sources: { sources: [{ id: "s1", url: "https://example.com", title: "Bees", site: "Example", text: "Bees fly." }] },
  lang: "en" as const,
  mode: "standard" as const,
};
const draft = {
  title: "Bees", summary: "About bees",
  chapters: [1, 2, 3].map((segmentIndex) => ({ title: "Bees", segmentIndex })),
  segments: ["intro", "content", "content", "content", "recap", "outro"].map((kind) => ({
    kind, speaker: "host", lang: "en", text: "Bees can fly.",
    ...(kind === "content" ? { sourceIds: ["s1"] } : {}),
  })),
};

test("prepares a share warning and schema, and imports a validated draft", () => {
  const prepared = prepareManualDraft(input);
  expect(prepared.warning).toMatch(/share/i);
  expect(prepared.prompt).toContain("Bees fly.");
  expect(prepared.schema).toHaveProperty("properties.segments");
  const script = parseManualDraft(JSON.stringify(draft), input);
  expect(script.segments[0]?.id).toBe("seg-0001");
});

test("rejects corrupt, oversized, wrong-budget and unknown-source responses", () => {
  expect(() => parseManualDraft("{", input)).toThrow();
  expect(() => parseManualDraft(" ".repeat(1_000_001), input)).toThrow();
  expect(() => parseManualDraft(JSON.stringify({ ...draft, segments: draft.segments.map((s) => ({ ...s, text: "one" })) }), input)).toThrow();
  expect(() => parseManualDraft(JSON.stringify({ ...draft, segments: draft.segments.map((s) => ({ ...s, ...(s.kind === "content" ? { sourceIds: ["unknown"] } : {}) })) }), input)).toThrow();
});
