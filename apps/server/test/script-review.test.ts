import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { createAiSdkLlmProvider } from "../src/providers/llm/ai-sdk.ts";
import { ScriptSegmentSchema } from "shared";
import { responseSchemaFor, runScriptStage } from "../src/pipeline/script.ts";
import { runReviewStage } from "../src/pipeline/review.ts";
import { FakeLlmProvider } from "../src/providers/llm/fake.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  removeTempDir(dir);
});

const plan = { queries: ["a", "b", "c", "d", "e"], angle: "Bees", targetWordCount: 18 };
const sources = {
  sources: [1, 2, 3].map((n) => ({
    id: `s${n}`,
    url: `https://example.com/${n}`,
    title: "Bees",
    site: "Example",
    text: "Bees fly.",
  })),
};
const notes = {
  facts: [{ sourceId: "s1", text: "Bees fly." }],
  outline: [{ heading: "Bees", facts: [{ text: "Bees fly.", sourceIds: ["s1"] }] }],
};
const draft = {
  title: "Bees",
  summary: "About bees",
  chapters: [
    { title: "One", segmentIndex: 1 },
    { title: "Two", segmentIndex: 2 },
    { title: "Three", segmentIndex: 3 },
  ],
  segments: [
    { kind: "intro", speaker: "host", lang: "en", text: "Welcome to bees." },
    { kind: "content", speaker: "host", lang: "en", text: "Bees fly around.", sourceIds: ["s1"] },
    { kind: "content", speaker: "host", lang: "en", text: "Bees fly around.", sourceIds: ["s1"] },
    { kind: "content", speaker: "host", lang: "en", text: "Bees fly around.", sourceIds: ["s1"] },
    { kind: "recap", speaker: "host", lang: "en", text: "Bees can fly." },
    { kind: "outro", speaker: "host", lang: "en", text: "Thanks for listening." },
  ],
};

class LocalFake extends FakeLlmProvider {
  readonly localCacheIdentity = "local";
}

const localParts = [
  {
    title: "One",
    summary: "Bees",
    intro: "Welcome to the bees.",
    content: [{ text: "Bees fly all around.", sourceIds: ["s1"] }],
  },
  {
    title: "Two",
    summary: "Bees",
    content: [
      { text: "Bees fly all around.", sourceIds: ["s1"] },
      { text: "Bees fly all around.", sourceIds: ["s1"] },
    ],
  },
  {
    title: "Three",
    summary: "Bees",
    content: [{ text: "Bees fly.", sourceIds: ["s1"] }],
    recap: "Bees can fly.",
    outro: "Thanks for listening.",
  },
];

test("local script computes indices, validates budget and caches", async () => {
  const llm = new LocalFake({ responses: localParts });
  const input = {
    plan: { ...plan, targetWordCount: 24 },
    notes,
    sources,
    lang: "en" as const,
    mode: "standard" as const,
  };
  const result = await runScriptStage({ workDir: dir, llm }, input);
  expect(result.artifact.chapters.map((c) => c.segmentIndex)).toEqual([1, 2, 4]);
  expect(responseSchemaFor(input).safeParse(result.artifact).success).toBe(true);
  expect(result.usage).toHaveLength(3);
  expect((await runScriptStage({ workDir: dir, llm }, input)).skipped).toBe(true);
  expect(llm.calls).toHaveLength(3);
});

test.each([
  { ...localParts[0], intro: "Hi", content: [{ text: "Short", sourceIds: ["s1"] }] },
  { ...localParts[0], content: [{ text: "Bees fly around.", sourceIds: ["s99"] }] },
])("local part rejects invalid length or citations", async (bad) => {
  const llm = new LocalFake({ responses: [bad] });
  await expect(
    runScriptStage(
      { workDir: dir, llm },
      {
        plan: { ...plan, targetWordCount: 24 },
        notes,
        sources,
        lang: "en",
        mode: "standard",
      },
    ),
  ).rejects.toThrow();
});

test("local provider retries a short chapter with feedback", async () => {
  const bad = { ...localParts[0], intro: "Hi", content: [{ text: "Short", sourceIds: ["s1"] }] };
  const answers = [bad, ...localParts];
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    void _url;
    void _init;
    const content = JSON.stringify(answers[fetchMock.mock.calls.length - 1]);
    const chunk = {
      id: "x",
      model: "tiny",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
    const end = {
      id: "x",
      model: "tiny",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}

data: ${JSON.stringify(end)}

data: [DONE]

`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const llm = createAiSdkLlmProvider(parseConfig({ PROFILE: "local" }), "ollama", {
      env: { OLLAMA_BOUNDED_OUTPUT: "1" },
    });
    await runScriptStage(
      { workDir: dir, llm },
      { plan: { ...plan, targetWordCount: 24 }, notes, sources, lang: "en", mode: "standard" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      JSON.stringify(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).messages),
    ).toContain("Word count");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("local script and review request bounded streaming deadlines", async () => {
  const llm = new LocalFake({ responses: localParts });
  const script = (
    await runScriptStage(
      { workDir: dir, llm },
      { plan: { ...plan, targetWordCount: 24 }, notes, sources, lang: "en", mode: "standard" },
    )
  ).artifact;
  llm.enqueue({ segments: script.segments, findings: [] });
  await runReviewStage(
    { workDir: dir, llm },
    { script, notes, sources, plan: { ...plan, targetWordCount: 24 } },
  );
  expect(llm.calls.map((call) => call.localTimeoutMs)).toEqual([
    900_000, 900_000, 900_000, 900_000,
  ]);
});

test("script assigns valid segment ids and caches the artifact", async () => {
  const llm = new FakeLlmProvider({ responses: [draft] });
  const input = { plan, notes, sources, lang: "en", mode: "standard" as const };
  const first = await runScriptStage({ workDir: dir, llm }, input);
  expect(first.artifact.segments.map((s) => ScriptSegmentSchema.parse(s).id)).toEqual([
    "seg-0001",
    "seg-0002",
    "seg-0003",
    "seg-0004",
    "seg-0005",
    "seg-0006",
  ]);
  expect(JSON.parse(readFileSync(path.join(dir, "script.json"), "utf8"))).toEqual(first.artifact);
  expect((await runScriptStage({ workDir: dir, llm }, input)).skipped).toBe(true);
  expect(llm.calls[0]?.slot).toBe("main");
});

test("validation rejects unknown citations, missing citations and budget violations", () => {
  const schema = responseSchemaFor({ plan, notes, sources, lang: "en", mode: "standard" });
  expect(schema.safeParse(draft).success).toBe(true);
  expect(
    schema.safeParse({
      ...draft,
      segments: draft.segments.map((s, i) => (i === 1 ? { ...s, sourceIds: ["s99"] } : s)),
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ...draft,
      segments: draft.segments.map((s, i) => (i === 1 ? { ...s, sourceIds: [] } : s)),
    }).success,
  ).toBe(false);
  expect(
    responseSchemaFor({
      plan: { ...plan, targetWordCount: 500 },
      notes,
      sources,
      lang: "en",
      mode: "standard",
    }).safeParse(draft).success,
  ).toBe(false);
});

test("review can be skipped and cached without a model call", async () => {
  const llm = new FakeLlmProvider({ responses: [draft] });
  const script = (
    await runScriptStage(
      { workDir: dir, llm },
      { plan, notes, sources, lang: "en", mode: "standard" },
    )
  ).artifact;
  const input = { script, notes, sources, plan, noReview: true };
  const first = await runReviewStage({ workDir: dir, llm }, input);
  expect(first.artifact).toEqual({ script, findings: [], skipped: true });
  expect((await runReviewStage({ workDir: dir, llm }, input)).skipped).toBe(true);
  expect(llm.calls).toHaveLength(1);
});

test("review flags and fixes an ungrounded claim without changing the draft", async () => {
  const llm = new FakeLlmProvider({
    responses: [
      draft,
      {
        segments: draft.segments.map((s, i) => ({
          ...s,
          ...(i === 1 ? { text: "Bees fly." } : {}),
        })),
        findings: [
          {
            segmentId: "seg-0002",
            claim: "Bees fly around.",
            action: "fixed",
            reason: "Unsupported detail",
          },
        ],
      },
    ],
  });
  const script = (
    await runScriptStage(
      { workDir: dir, llm },
      { plan, notes, sources, lang: "en", mode: "standard" },
    )
  ).artifact;
  const review = await runReviewStage({ workDir: dir, llm }, { script, notes, sources, plan });
  expect(review.artifact.findings[0]?.segmentId).toBe("seg-0002");
  expect(review.artifact.script.segments[1]?.text).toBe("Bees fly.");
  expect(JSON.parse(readFileSync(path.join(dir, "script.json"), "utf8"))).toEqual(script);
  expect(JSON.parse(readFileSync(path.join(dir, "reviewed-script.json"), "utf8"))).toEqual(
    review.artifact.script,
  );
  expect(JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8")).findings).toEqual(
    review.artifact.findings,
  );
});
