import { TokenSchema, type Lang, type ScriptSegment } from "shared";
import { z } from "zod";
import type { LlmProvider } from "../providers/llm/interface.ts";
import { validateGradedSegments } from "./graded-validation.ts";
import { escapeSourceText, loadPrompt, renderPrompt } from "./prompts.ts";

/** Annotate one batch after proofreading; caller handles caching and episode-wide checks. */
export async function annotateGradedBatch(
  llm: LlmProvider,
  segments: readonly ScriptSegment[],
  nativeLang: Lang,
) {
  if (
    !segments.length ||
    segments.length > 10 ||
    segments.some((s) => s.lang.toLowerCase() !== "hu")
  )
    throw new Error("Annotation requires 1–10 Hungarian segments");
  const schema = z
    .object({
      annotations: z.array(
        z.object({
          id: z.string(),
          translation: z.string().trim().min(1),
          tokens: z.array(TokenSchema).min(1),
        }),
      ),
    })
    .superRefine((value, ctx) => {
      if (
        value.annotations.length !== segments.length ||
        value.annotations.some((a, i) => a.id !== segments[i]?.id)
      ) {
        ctx.addIssue({ code: "custom", message: "Annotations must match segment ids in order" });
        return;
      }
      value.annotations.forEach((annotation, i) => {
        const segment = {
          ...segments[i]!,
          ...annotation,
          tokens: annotation.tokens.map((t) => ({ ...t, isTarget: false })),
        };
        for (const error of validateGradedSegments([segment], "A2").filter(
          (e) => !e.includes("words"),
        ))
          ctx.addIssue({ code: "custom", message: error, path: ["annotations", i] });
      });
    });
  const template = loadPrompt("graded-annotation");
  const { system, prompt } = renderPrompt(
    template,
    {
      nativeLang,
      sentences: escapeSourceText(JSON.stringify(segments.map(({ id, text }) => ({ id, text })))),
    },
    "graded-annotation",
  );
  const { object, usage } = await llm.generateObject({ slot: "main", system, prompt, schema });
  return {
    segments: segments.map((segment, i) => ({
      ...segment,
      translation: object.annotations[i]!.translation,
      tokens: object.annotations[i]!.tokens,
    })),
    usage,
  };
}
