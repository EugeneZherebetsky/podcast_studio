import { ScriptSegmentSchema, type Lang } from "shared";
import { z } from "zod";
import type { LlmProvider, Usage } from "../providers/llm/interface.ts";
import { runCachedStage, type StageResult } from "./artifacts.ts";
import { escapeSourceText, loadPrompt, renderPrompt, type PromptTemplate } from "./prompts.ts";
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
async function runLocalScript(deps: ScriptDeps, input: ScriptInput, template: PromptTemplate) {
  const text = z.string().trim().min(1);
  const ids = new Set(input.sources.sources.map((source) => source.id));
  const usage: Usage[] = [];
  const segments: z.infer<typeof SegmentResponseSchema>[] = [];
  const chapters: { title: string; segmentIndex: number }[] = [];
  let title = "";
  let summary = "";
  const target = input.plan.targetWordCount;
  for (let i = 0; i < 3; i++) {
    const budget = Math.floor(target / 3) + (i < target % 3 ? 1 : 0);
    const schema = z
      .object({
        title: text,
        summary: text,
        ...(i === 0 ? { intro: text } : {}),
        content: z.array(z.object({ text, sourceIds: z.array(text).min(1) })).min(1),
        ...(i === 2 ? { recap: text, outro: text } : {}),
      })
      .superRefine((part, ctx) => {
        const spoken = [
          part.intro,
          ...part.content.map((s) => s.text),
          part.recap,
          part.outro,
        ].filter((s): s is string => typeof s === "string");
        const words = spoken.reduce((n, s) => n + s.trim().split(/\s+/u).length, 0);
        if (words < budget * 0.8 || words > budget * 1.2)
          ctx.addIssue({
            code: "custom",
            message: `Word count ${words} must be within 20% of ${budget}`,
          });
        part.content.forEach((segment, index) =>
          segment.sourceIds.forEach((id) => {
            if (!ids.has(id))
              ctx.addIssue({
                code: "custom",
                path: ["content", index, "sourceIds"],
                message: `Unknown source id ${id}`,
              });
          }),
        );
      });
    const { system, prompt } = renderPrompt(
      template,
      {
        lang: input.lang,
        part: String(i + 1),
        budget: String(budget),
        boundary:
          i === 0
            ? "Include an intro before content."
            : i === 2
              ? "Include a recap and outro after content."
              : "Only write chapter content.",
        notes: escapeSourceText(JSON.stringify({ plan: input.plan, notes: input.notes })),
      },
      "local-script",
    );
    const result = await deps.llm.generateObject({
      slot: "main",
      system,
      prompt,
      schema,
      localTimeoutMs: 900_000,
    });
    usage.push(result.usage);
    const part = result.object;
    if (i === 0) {
      title = part.title;
      summary = part.summary;
    }
    const segment = (kind: "intro" | "recap" | "outro", value: string) => ({
      kind,
      speaker: "host" as const,
      lang: input.lang,
      text: value,
    });
    if (typeof part.intro === "string") segments.push(segment("intro", part.intro));
    chapters.push({ title: part.title, segmentIndex: segments.length });
    segments.push(
      ...part.content.map((item) => ({
        ...item,
        kind: "content" as const,
        speaker: "host" as const,
        lang: input.lang,
      })),
    );
    if (typeof part.recap === "string") segments.push(segment("recap", part.recap));
    if (typeof part.outro === "string") segments.push(segment("outro", part.outro));
  }
  const object = responseSchemaFor(input).parse({ title, summary, chapters, segments });
  return { artifact: { ...object, segments: assignIds(object.segments) }, usage };
}

export async function runScriptStage(
  deps: ScriptDeps,
  input: ScriptInput,
): Promise<StageResult<Script>> {
  if (input.mode !== "standard") throw new Error("Script stage supports standard mode only");
  const template = loadPrompt("script");
  const localTemplate = deps.llm.localCacheIdentity ? loadPrompt("local-script") : undefined;
  return runCachedStage({
    workDir: deps.workDir,
    stage: "script",
    inputs: {
      ...input,
      template,
      ...(localTemplate ? { localTemplate, localModel: deps.llm.localCacheIdentity } : {}),
    },
    schema: ScriptSchema,
    run: async () => {
      if (localTemplate) return runLocalScript(deps, input, localTemplate);
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
        ...(deps.llm.localCacheIdentity ? { localTimeoutMs: 900_000 } : {}),
        schema: responseSchemaFor(input),
      });
      return { artifact: { ...object, segments: assignIds(object.segments) }, usage: [usage] };
    },
  });
}
