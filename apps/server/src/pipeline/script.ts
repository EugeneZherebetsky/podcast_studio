import { ScriptSegmentSchema, type Lang } from "shared";
import { z } from "zod";
import type { LlmProvider } from "../providers/llm/interface.ts";
import { runCachedStage, type StageResult } from "./artifacts.ts";
import { escapeSourceText, loadPrompt, renderPrompt } from "./prompts.ts";
import type { Notes, Plan, Sources } from "./schemas.ts";

const SegmentResponseSchema = ScriptSegmentSchema.omit({ id: true }).extend({
  kind: z.enum(["intro", "content", "recap", "outro"]),
  speaker: z.literal("host"),
  text: z.string().trim().min(1),
});
export const ScriptResponseSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  chapters: z
    .array(
      z.object({ title: z.string().trim().min(1), segmentIndex: z.number().int().nonnegative() }),
    )
    .min(3)
    .max(5),
  segments: z.array(SegmentResponseSchema).min(5),
});
export const ScriptSchema = ScriptResponseSchema.extend({
  segments: z.array(ScriptSegmentSchema).min(5),
});
export type Script = z.infer<typeof ScriptSchema>;
export interface ScriptInput {
  plan: Plan;
  notes: Notes;
  sources: Sources;
  lang: Lang;
  mode: "standard";
}
export interface ScriptDeps {
  workDir: string;
  llm: LlmProvider;
}

export function responseSchemaFor(input: ScriptInput) {
  const ids = new Set(input.sources.sources.map((s) => s.id));
  return ScriptResponseSchema.superRefine((script, ctx) => {
    const words = script.segments.reduce((n, s) => n + s.text.trim().split(/\s+/u).length, 0);
    if (words < input.plan.targetWordCount * 0.8 || words > input.plan.targetWordCount * 1.2)
      ctx.addIssue({
        code: "custom",
        message: `Word count ${words} must be within 20% of ${input.plan.targetWordCount}`,
      });
    const kinds = script.segments.map((s) => s.kind);
    if (
      kinds[0] !== "intro" ||
      kinds.at(-2) !== "recap" ||
      kinds.at(-1) !== "outro" ||
      kinds.slice(1, -2).some((kind) => kind !== "content")
    )
      ctx.addIssue({ code: "custom", message: "Expected intro, content, recap, outro in order" });
    script.segments.forEach((s, i) => {
      if (s.lang !== input.lang)
        ctx.addIssue({ code: "custom", path: ["segments", i, "lang"], message: "Wrong language" });
      if (s.kind === "content" && !s.sourceIds?.length)
        ctx.addIssue({
          code: "custom",
          path: ["segments", i, "sourceIds"],
          message: "Content requires sources",
        });
      s.sourceIds?.forEach((id) => {
        if (!ids.has(id))
          ctx.addIssue({
            code: "custom",
            path: ["segments", i, "sourceIds"],
            message: `Unknown source id ${id}`,
          });
      });
    });
    let previous = 0;
    script.chapters.forEach((chapter, i) => {
      if (
        chapter.segmentIndex <= previous ||
        script.segments[chapter.segmentIndex]?.kind !== "content"
      )
        ctx.addIssue({
          code: "custom",
          path: ["chapters", i, "segmentIndex"],
          message: "Chapter must start at a later content segment",
        });
      previous = chapter.segmentIndex;
    });
    if (script.chapters[0]?.segmentIndex !== 1)
      ctx.addIssue({
        code: "custom",
        path: ["chapters", 0],
        message: "First chapter must start at first content segment",
      });
  });
}
export function assignIds<T extends z.infer<typeof SegmentResponseSchema>>(segments: T[]) {
  return segments.map((segment, i) => ({
    ...segment,
    id: `seg-${String(i + 1).padStart(4, "0")}`,
  }));
}
export async function runScriptStage(
  deps: ScriptDeps,
  input: ScriptInput,
): Promise<StageResult<Script>> {
  if (input.mode !== "standard") throw new Error("Script stage supports standard mode only");
  const template = loadPrompt("script");
  return runCachedStage({
    workDir: deps.workDir,
    stage: "script",
    inputs: { ...input, template },
    schema: ScriptSchema,
    run: async () => {
      const { system, prompt } = renderPrompt(
        template,
        {
          lang: input.lang,
          budget: String(input.plan.targetWordCount),
          notes: escapeSourceText(JSON.stringify({ plan: input.plan, notes: input.notes })),
        },
        "script",
      );
      const { object, usage } = await deps.llm.generateObject({
        slot: "main",
        system,
        prompt,
        schema: responseSchemaFor(input),
      });
      return { artifact: { ...object, segments: assignIds(object.segments) }, usage: [usage] };
    },
  });
}
