import { expect, test } from "vitest";
import { validateGradedSegments } from "../src/pipeline/graded-validation.ts";
import type { ScriptSegment } from "shared";

const token = (surface: string, lemma = surface, isTarget = false) => ({
  surface,
  lemma,
  pos: "noun",
  gloss: "example",
  morphemes: [{ form: surface, meaning: "example" }],
  isTarget,
});
const segment = (text: string, tokens: ReturnType<typeof token>[]): ScriptSegment => ({
  id: "s1",
  kind: "content",
  speaker: "host",
  lang: "hu",
  text,
  translation: "Example.",
  tokens,
});

test("validates exact token coverage allowing only punctuation and whitespace between words", () => {
  expect(
    validateGradedSegments([segment("Ház, ház!", [token("Ház"), token("ház")])], "A1"),
  ).toEqual([]);
  expect(
    validateGradedSegments([segment("Ház + ház", [token("Ház"), token("ház")])], "A1"),
  ).toContainEqual(expect.stringContaining("reconstruct"));
  expect(
    validateGradedSegments([segment("Ház és ház!", [token("Ház"), token("ház")])], "A1"),
  ).toContainEqual(expect.stringContaining("reconstruct"));
  expect(validateGradedSegments([segment("Ház!", [token("ház")])], "A1")).toContainEqual(
    expect.stringContaining("reconstruct"),
  );
  expect(validateGradedSegments([segment("Ház", [token("Há"), token("z")])], "A1")).toContainEqual(
    expect.stringContaining("reconstruct"),
  );
  expect(
    validateGradedSegments(
      [
        {
          ...segment("Ház", [token("Ház")]),
          translation: "",
          tokens: [{ ...token("Ház"), morphemes: [] }],
        },
      ],
      "A1",
    ),
  ).toContainEqual(expect.stringContaining("annotation"));
});

test("checks sentence word limits and target lemma occurrences across segments", () => {
  const many = Array.from({ length: 9 }, () => token("ház", "ház", true));
  expect(
    validateGradedSegments([segment(many.map((t) => t.surface).join(" "), many)], "A1"),
  ).toContainEqual(expect.stringContaining("8 words"));
  expect(validateGradedSegments([segment("ház ház", many.slice(0, 2))], "A2")).toContainEqual(
    expect.stringContaining("at least 3"),
  );
  expect(validateGradedSegments([segment("ház ház ház", many.slice(0, 3))], "A2")).toEqual([]);
});
