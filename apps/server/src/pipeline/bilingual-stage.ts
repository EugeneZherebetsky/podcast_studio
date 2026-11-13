import { LangSchema, ScriptSegmentSchema, type Lang } from "shared";
import { z } from "zod";
import { annotateGradedBatch } from "./graded-annotation.ts";
import { runCachedStage } from "./artifacts.ts";
import { escapeSourceText, loadPrompt, renderPrompt } from "./prompts.ts";
import { ScriptSchema, type ScriptDeps } from "./script.ts";
import type { Notes, Plan, Sources } from "./schemas.ts";

export interface BilingualInput {
  plan: Plan;
  notes: Notes;
  sources: Sources;
  nativeLang: Lang;
  minutes: number;
  voices: { host: string; teacher: string };
}

const DraftSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  chapters: z
    .array(
      z.object({ title: z.string().trim().min(1), sentenceIndex: z.number().int().nonnegative() }),
    )
    .min(3)
    .max(5),
  sentences: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        explanation: z.string().trim().min(1),
        sourceIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

export async function runBilingualGeneration(deps: ScriptDeps, input: BilingualInput) {
  LangSchema.parse(input.nativeLang);
  if (input.nativeLang.toLowerCase().split("-")[0] === "hu")
    throw new Error("Native language must differ from Hungarian");
  z.number().positive().finite().parse(input.minutes);
  const voices = z
    .object({ host: z.string().trim().min(1), teacher: z.string().trim().min(1) })
    .parse(input.voices);
  if (voices.host === voices.teacher) throw new Error("Host and teacher voices must differ");
  const ids = new Set(input.sources.sources.map((source) => source.id));
  const draftSchema = DraftSchema.superRefine((draft, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (
      draft.sentences.length < Math.ceil(input.minutes * 1.2) ||
      draft.sentences.length > Math.floor(input.minutes * 2)
    )
      issue("Key sentence count must be 12–20 per 10 minutes");
    for (const sentence of draft.sentences) {
      if (sentence.sourceIds.some((id) => !ids.has(id))) issue("Unknown source id");
      if ((sentence.text.match(/[.!?]+(?=\s|$)/gu) ?? []).length > 1)
        issue("Each key sentence must contain one sentence");
      if ((sentence.explanation.match(/[.!?]+(?=\s|$)/gu) ?? []).length > 2)
        issue("Teacher explanation must contain at most two sentences");
    }
    let previous = -1;
    for (const chapter of draft.chapters) {
      if (chapter.sentenceIndex <= previous || chapter.sentenceIndex >= draft.sentences.length)
        issue("Invalid chapter index");
      previous = chapter.sentenceIndex;
    }
    if (draft.chapters[0]?.sentenceIndex !== 0) issue("First chapter must begin at first sentence");
  });
  const prompt = loadPrompt("bilingual-script");
  const script = await runCachedStage({
    workDir: deps.workDir,
    stage: "script",
    inputs: { input, prompt, version: 1, model: deps.llm.cacheIdentity ?? deps.llm.localCacheIdentity },
    schema: ScriptSchema,
    run: async () => {
      const result = await deps.llm.generateObject({
        slot: "main",
        schema: draftSchema,
        ...renderPrompt(prompt, {
          nativeLang: input.nativeLang,
          minutes: String(input.minutes),
          research: escapeSourceText(JSON.stringify({ plan: input.plan, notes: input.notes })),
        }),
      });
      const segments = result.object.sentences.flatMap((sentence, index) => {
        const id = (offset: number) => `seg-${String(index * 3 + offset).padStart(4, "0")}`;
        return [
          {
            id: id(1),
            kind: "content" as const,
            speaker: "host" as const,
            lang: "hu",
            text: sentence.text,
            sourceIds: sentence.sourceIds,
            rate: 0.8,
            pauseAfterMs: 1200,
          },
          {
            id: id(2),
            kind: "explanation" as const,
            speaker: "teacher" as const,
            lang: input.nativeLang,
            text: sentence.explanation,
          },
          {
            id: id(3),
            kind: "content" as const,
            speaker: "host" as const,
            lang: "hu",
            text: sentence.text,
            sourceIds: sentence.sourceIds,
            rate: 1,
            repeatOf: id(1),
          },
        ];
      });
      return {
        artifact: {
          title: result.object.title,
          summary: result.object.summary,
          chapters: result.object.chapters.map((c) => ({
            title: c.title,
            segmentIndex: c.sentenceIndex * 3,
          })),
          segments,
        },
        usage: result.usage ? [result.usage] : [],
      };
    },
  });
  const review = await runCachedStage({
    workDir: deps.workDir,
    stage: "review",
    inputs: { input, script: script.artifact, prompt: loadPrompt("graded-annotation"), version: 1, model: deps.llm.cacheIdentity ?? deps.llm.localCacheIdentity },
    schema: z.object({
      script: ScriptSchema.extend({ segments: z.array(ScriptSegmentSchema).min(5) }),
    }),
    run: async () => {
      const segments = structuredClone(script.artifact.segments);
      const first = segments.filter((_, i) => i % 3 === 0);
      const usage = [];
      for (let i = 0; i < first.length; i += 10) {
        const batch = await annotateGradedBatch(deps.llm, first.slice(i, i + 10), input.nativeLang);
        if (batch.usage) usage.push(batch.usage);
        batch.segments.forEach((segment, j) => {
          const index = (i + j) * 3;
          segments[index] = segment;
          segments[index + 2] = {
            ...segments[index + 2]!,
            translation: segment.translation,
            tokens: segment.tokens,
          };
        });
      }
      return { artifact: { script: { ...script.artifact, segments } }, usage };
    },
  });
  return { script, review };
}
