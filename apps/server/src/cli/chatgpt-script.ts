import { LangSchema } from "shared";
import { z } from "zod";
import { escapeSourceText, loadPrompt, renderPrompt } from "../pipeline/prompts.ts";
import { NotesSchema, PlanSchema, SourcesSchema } from "../pipeline/schemas.ts";
import { assignIds, responseSchemaFor, ScriptResponseSchema } from "../pipeline/script.ts";

const InputSchema = z.object({
  plan: PlanSchema, notes: NotesSchema, sources: SourcesSchema,
  lang: LangSchema, mode: z.literal("standard"),
});

type Session = {
  generateStructured(model: string, system: string, prompt: string, schema: object, signal?: AbortSignal): Promise<string>;
};

export async function generatePodcastScript(session: Session, model: string, raw: unknown, signal?: AbortSignal) {
  const input = InputSchema.parse(raw);
  const ids = new Set(input.sources.sources.map((s) => s.id));
  if (ids.size !== input.sources.sources.length ||
      input.notes.facts.some((fact) => !ids.has(fact.sourceId)) ||
      input.notes.outline.some((section) => section.facts.some((fact) => fact.sourceIds.some((id) => !ids.has(id)))))
    throw new Error("Research contains unknown or duplicate source IDs");
  const { system, prompt } = renderPrompt(loadPrompt("script"), {
    lang: input.lang, budget: String(input.plan.targetWordCount),
    notes: escapeSourceText(JSON.stringify({ plan: input.plan, notes: input.notes })),
  }, "script");
  const text = await session.generateStructured(model, system, prompt, z.toJSONSchema(ScriptResponseSchema), signal);
  const object = responseSchemaFor(input).parse(JSON.parse(text));
  const evidenceIds = new Set(input.notes.facts.map((fact) => fact.sourceId));
  if (object.segments.some((segment) => segment.sourceIds?.some((id) => !evidenceIds.has(id))))
    throw new Error("Script cites a source without supporting research notes");
  return { reviewed: false as const, script: { ...object, segments: assignIds(object.segments) } };
}
