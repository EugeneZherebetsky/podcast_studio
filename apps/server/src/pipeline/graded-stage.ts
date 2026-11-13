import { LangSchema, TargetVocabularySchema, type Lang } from "shared";
import { z } from "zod";
import { runCachedStage } from "./artifacts.ts";
import type { Usage } from "../providers/llm/interface.ts";
import { annotateGradedBatch } from "./graded-annotation.ts";
import { validateGradedSegments } from "./graded-validation.ts";
import { escapeSourceText, loadPrompt, renderPrompt } from "./prompts.ts";
import { assignIds, ScriptResponseSchema, ScriptSchema, type ScriptDeps } from "./script.ts";
import type { Notes, Plan, Sources } from "./schemas.ts";

export interface GradedInput {
  plan: Plan;
  notes: Notes;
  sources: Sources;
  nativeLang: Lang;
  level: "A1" | "A2";
}
const DraftSchema = ScriptResponseSchema.extend({
  targetVocabulary: z.array(TargetVocabularySchema).min(6).max(10),
});
const GradedSchema = ScriptSchema.extend({
  targetVocabulary: z.array(TargetVocabularySchema).min(6).max(10),
});
const ReviewSchema = z.object({ script: GradedSchema });
const VERSION = 1;
const normalize = (s: string) => s.normalize("NFC").toLocaleLowerCase("hu");

function validateDraft(input: GradedInput) {
  return DraftSchema.superRefine((draft, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: "custom", message });
    const targets = draft.targetVocabulary.map((t) => normalize(t.lemma));
    if (new Set(targets).size !== targets.length) error("Target lemmas must be unique");
    const segments = draft.segments;
    if (
      segments[0]?.kind !== "intro" ||
      segments[1]?.kind !== "intro" ||
      segments.slice(0, 2).some((s) => s.lang !== input.nativeLang) ||
      segments.slice(2).some((s) => s.lang !== "hu") ||
      segments.slice(2).some((s) => !["content", "recap"].includes(s.kind)) ||
      segments.at(-1)?.kind !== "recap"
    )
      error("Expected two native-language intro segments, Hungarian content and recap");
    const content = segments.filter((s) => s.kind === "content");
    if (!content.length) error("Missing Hungarian content");
    const known = new Set(input.sources.sources.map((s) => s.id));
    for (const s of segments) {
      if (s.kind === "content" && !s.sourceIds?.length) error("Content requires sources");
      if (s.sourceIds?.some((id) => !known.has(id))) error("Unknown source id");
      if (s.lang === "hu") {
        if (s.rate !== (input.level === "A1" ? 0.85 : 0.95) || s.pauseAfterMs !== 600)
          error("Wrong Hungarian rate or pause");
        if ((s.text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length > (input.level === "A1" ? 8 : 12))
          error("Sentence exceeds level word limit");
        if (/\p{N}/u.test(s.text)) error("Write numbers as words");
      }
    }
    const words = segments
      .filter((s) => s.lang === "hu")
      .reduce((n, s) => n + (s.text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length, 0);
    if (words < input.plan.targetWordCount * 0.8 || words > input.plan.targetWordCount * 1.2)
      error("Hungarian word budget outside 20%");
    let previous = 1;
    for (const chapter of draft.chapters) {
      if (chapter.segmentIndex <= previous || segments[chapter.segmentIndex]?.kind !== "content")
        error("Invalid chapter index");
      previous = chapter.segmentIndex;
    }
    if (draft.chapters[0]?.segmentIndex !== 2)
      error("First chapter must begin at first content segment");
  });
}

class GradedValidationError extends Error {}

async function retryStructural<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof GradedValidationError)) throw error;
    return await run();
  }
}

/** Script and review are independently cached using the existing pipeline artifacts. */
export async function runGradedGeneration(deps: ScriptDeps, input: GradedInput) {
  LangSchema.parse(input.nativeLang);
  if (input.nativeLang.toLowerCase().split("-")[0] === "hu")
    throw new Error("Native language must differ from Hungarian");
  z.enum(["A1", "A2"]).parse(input.level);
  const schema = validateDraft(input);
  const prompt = loadPrompt("graded-script");
  const proofreadingPrompt = loadPrompt("graded-proofread");
  const levelPrompt = loadPrompt("graded-level-review");
  const script = await runCachedStage({
    workDir: deps.workDir,
    stage: "script",
    inputs: { input, version: VERSION, prompt, model: deps.llm.cacheIdentity ?? deps.llm.localCacheIdentity },
    schema: GradedSchema,
    run: async () => {
      const { object, usage } = await deps.llm.generateObject({
        slot: "main",
        schema,
        ...renderPrompt(prompt, {
          level: input.level,
          rate: input.level === "A1" ? "0.85" : "0.95",
          nativeLang: input.nativeLang,
          wordBudget: String(input.plan.targetWordCount),
          research: escapeSourceText(JSON.stringify({ plan: input.plan, notes: input.notes })),
        }),
      });
      return { artifact: { ...object, segments: assignIds(object.segments) }, usage: usage ? [usage] : [] };
    },
  });
  const review = await runCachedStage({
    workDir: deps.workDir,
    stage: "review",
    inputs: {
      input,
      script: script.artifact,
      version: VERSION,
      model: deps.llm.cacheIdentity ?? deps.llm.localCacheIdentity,
      annotationPrompt: loadPrompt("graded-annotation"),
      proofreadingPrompt,
      levelPrompt,
    },
    schema: ReviewSchema,
    run: async () => {
      const usage: Usage[] = [];
      return retryStructural(async () => {
        let current = script.artifact;
        for (const [template, isLevel] of [
          [proofreadingPrompt, false],
          [levelPrompt, true],
        ] as const) {
          const reviewSchema = z
            .object({ segments: ScriptResponseSchema.shape.segments })
            .superRefine((value, ctx) => {
              const candidate = schema.safeParse({ ...current, segments: value.segments });
              if (!candidate.success)
                for (const issue of candidate.error.issues)
                  ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
              if (
                value.segments.length !== current.segments.length ||
                value.segments.some((s, i) => s.kind !== current.segments[i]?.kind)
              )
                ctx.addIssue({ code: "custom", message: "Preserve segment count and kinds" });
            });
          const result = await deps.llm.generateObject({
            slot: "main",
            schema: reviewSchema,
            ...renderPrompt(template, {
              ...(isLevel ? { level: input.level } : {}),
              source: escapeSourceText(JSON.stringify({ script: current, notes: input.notes })),
            }),
          });
          if (result.usage) usage.push(result.usage);
          current = { ...current, segments: assignIds(result.object.segments) };
        }
        const targets = new Set(current.targetVocabulary.map((t) => normalize(t.lemma)));
        const hu = current.segments.filter((s) => s.lang === "hu");
        for (let i = 0; i < hu.length; i += 10) {
          const result = await annotateGradedBatch(deps.llm, hu.slice(i, i + 10), input.nativeLang);
          if (result.usage) usage.push(result.usage);
          for (const segment of result.segments) {
            const index = current.segments.findIndex((s) => s.id === segment.id);
            current.segments[index] = {
              ...segment,
              tokens: segment.tokens.map((t) => ({
                ...t,
                isTarget: targets.has(normalize(t.lemma)),
              })),
            };
          }
        }
        const errors = validateGradedSegments(current.segments, input.level);
        for (const target of targets)
          if (!current.segments.some((s) => s.tokens?.some((t) => normalize(t.lemma) === target)))
            errors.push(`${target}: target not found`);
        if (errors.length)
          throw new GradedValidationError(`Graded validation failed: ${errors.join("; ")}`);
        return { artifact: { script: current }, usage };
      });
    },
  });
  return { script, review };
}
