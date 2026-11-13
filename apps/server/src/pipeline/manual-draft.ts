// Draft validation and prompt generation; the manual workflow keeps imports isolated.
import { z } from "zod";
import { escapeSourceText, loadPrompt, renderPrompt } from "./prompts.ts";
import { assignIds, responseSchemaFor, ScriptResponseSchema, type ScriptInput } from "./script.ts";

const MAX_RESPONSE_BYTES = 1_000_000;

export function prepareManualDraft(input: ScriptInput) {
  const { system, prompt } = renderPrompt(loadPrompt("script"), {
    lang: input.lang,
    budget: String(input.plan.targetWordCount),
    notes: escapeSourceText(JSON.stringify({ plan: input.plan, notes: input.notes })),
  }, "script");
  return {
    warning: "Pasting this prompt into an external service will share the topic and research notes with that service. Review its privacy policy first.",
    prompt: `${system}\n\n${prompt}`,
    schema: z.toJSONSchema(ScriptResponseSchema),
  };
}

export function parseManualDraft(text: string, input: ScriptInput) {
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
    throw new Error("Manual draft exceeds the size limit");
  const response: unknown = JSON.parse(text);
  const parsed = responseSchemaFor(input).parse(response);
  return { ...parsed, segments: assignIds(parsed.segments) };
}
