import { expect, test } from "vitest";
import { prepareManualDraft, parseManualDraft } from "../src/pipeline/manual-draft.ts";

const input = {
  plan: { queries: ["a", "b", "c", "d", "e"], angle: "Bees", targetWordCount: 18 },
  notes: {
    facts: [{ sourceId: "s1", text: "Bees fly." }],
    outline: [{ heading: "Bees", facts: [{ text: "Bees fly.", sourceIds: ["s1"] }] }],
  },
  sources: {
    sources: [
      { id: "s1", url: "https://example.com", title: "Bees", site: "Example", text: "Bees fly." },
    ],
  },
  lang: "en" as const,
  mode: "standard" as const,
};
const draft = {
  title: "Bees",
  summary: "About bees",
  chapters: [1, 2, 3].map((segmentIndex) => ({ title: "Bees", segmentIndex })),
  segments: ["intro", "content", "content", "content", "recap", "outro"].map((kind) => ({
    kind,
    speaker: "host",
    lang: "en",
    text: "Bees can fly.",
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
  expect(() =>
    parseManualDraft(
      JSON.stringify({ ...draft, segments: draft.segments.map((s) => ({ ...s, text: "one" })) }),
      input,
    ),
  ).toThrow();
  expect(() =>
    parseManualDraft(
      JSON.stringify({
        ...draft,
        segments: draft.segments.map((s) => ({
          ...s,
          ...(s.kind === "content" ? { sourceIds: ["unknown"] } : {}),
        })),
      }),
      input,
    ),
  ).toThrow();
});

test("manual workflow prepares a job snapshot and imports a validated draft into isolated storage", async () => {
  const { manualPrepare, manualImport } = await import("../src/pipeline/manual-workflow.ts");
  const { openDatabase } = await import("../src/db/index.ts");
  const { createJob } = await import("../src/pipeline/runner.ts");
  const { makeTempDir, removeTempDir } = await import("./temp-dir.ts");
  const { writeFile, readFile, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  try {
    const job = createJob(
      db,
      { title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 8 },
      20,
    );
    const work = path.join(dir, "jobs", job.id);
    await mkdir(work, { recursive: true });
    for (const [name, value] of Object.entries({
      plan: input.plan,
      notes: input.notes,
      sources: {
        sources: [
          input.sources.sources[0],
          { ...input.sources.sources[0], id: "s2" },
          { ...input.sources.sources[0], id: "s3" },
        ],
      },
    }))
      await writeFile(path.join(work, `${name}.json`), JSON.stringify(value));
    const pending = manualPrepare(db, dir, job.id);
    await expect(manualPrepare(db, dir, job.id)).rejects.toThrow(/queued or failed/);
    const prepared = await pending;
    expect(await readFile(path.join(prepared, "prompt.txt"), "utf8")).toContain("Bees fly.");
    await expect(manualImport(db, dir, job.id, prepared, "{}")).rejects.toThrow();
    const imported = await manualImport(db, dir, job.id, prepared, JSON.stringify(draft));
    expect(JSON.parse(await readFile(imported, "utf8")).segments[0].id).toBe("seg-0001");
    await writeFile(
      path.join(work, "plan.json"),
      JSON.stringify({ ...input.plan, angle: "Changed" }),
    );
    await expect(manualImport(db, dir, job.id, prepared, JSON.stringify(draft))).rejects.toThrow(
      /changed since preparation/,
    );
    const { startJob } = await import("../src/pipeline/runner.ts");
    startJob(db, job.id, 20);
    await expect(manualPrepare(db, dir, job.id)).rejects.toThrow(/queued or failed/);
    await expect(manualImport(db, dir, job.id, prepared, JSON.stringify(draft))).rejects.toThrow(
      /queued or failed/,
    );
  } finally {
    db.$client.close();
    removeTempDir(dir);
  }
});
