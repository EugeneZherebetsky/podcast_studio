import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runCachedStage, type StageResult } from "./artifacts.ts";
import { escapeSourceText, loadPrompt, renderPrompt } from "./prompts.ts";
import {
  assignIds,
  responseSchemaFor,
  ScriptResponseSchema,
  ScriptSchema,
  type Script,
  type ScriptDeps,
  type ScriptInput,
} from "./script.ts";
import type { Notes, Plan, Sources } from "./schemas.ts";

const FindingSchema = z.object({
  segmentId: z.string().min(1),
  claim: z.string().min(1),
  action: z.enum(["fixed", "removed"]),
  reason: z.string().min(1),
});
const ReviewSchema = z.object({
  script: ScriptSchema,
  findings: z.array(FindingSchema),
  skipped: z.boolean(),
});
type Review = z.infer<typeof ReviewSchema>;
export interface ReviewInput {
  script: Script;
  notes: Notes;
  sources: Sources;
  plan: Plan;
  noReview?: boolean;
}

export async function runReviewStage(
  deps: ScriptDeps,
  input: ReviewInput,
): Promise<StageResult<Review>> {
  const template = loadPrompt("review");
  const scriptInput: ScriptInput = {
    plan: input.plan,
    notes: input.notes,
    sources: input.sources,
    lang: input.script.segments[0]!.lang,
    mode: "standard",
  };
  const responseSchema = z
    .object({ segments: ScriptResponseSchema.shape.segments, findings: z.array(FindingSchema) })
    .superRefine((response, ctx) => {
      const validation = responseSchemaFor(scriptInput).safeParse({
        ...input.script,
        segments: response.segments,
      });
      if (!validation.success)
        for (const issue of validation.error.issues)
          ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      if (
        response.segments.length !== input.script.segments.length ||
        response.segments.some((s, i) => s.kind !== input.script.segments[i]?.kind)
      )
        ctx.addIssue({ code: "custom", message: "Review must preserve segment count and kinds" });
      for (const finding of response.findings)
        if (!input.script.segments.some((s) => s.id === finding.segmentId))
          ctx.addIssue({ code: "custom", message: `Unknown segment ${finding.segmentId}` });
    });
  const result = await runCachedStage({
    workDir: deps.workDir,
    stage: "review",
    inputs: { ...input, template },
    schema: ReviewSchema,
    run: async () => {
      if (input.noReview)
        return { artifact: { script: input.script, findings: [], skipped: true }, usage: [] };
      const { system, prompt } = renderPrompt(
        template,
        {
          budget: String(input.plan.targetWordCount),
          notes: escapeSourceText(JSON.stringify(input.notes)),
          script: escapeSourceText(JSON.stringify(input.script)),
        },
        "review",
      );
      const { object, usage } = await deps.llm.generateObject({
        slot: "main",
        system,
        prompt,
        schema: responseSchema,
      });
      return {
        artifact: {
          script: { ...input.script, segments: assignIds(object.segments) },
          findings: object.findings,
          skipped: false,
        },
        usage: [usage],
      };
    },
  });
  const file = path.join(deps.workDir, "reviewed-script.json");
  const content = `${JSON.stringify(result.artifact.script, null, 2)}\n`;
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing !== content) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, content, "utf8");
    await rename(temp, file);
  }
  return result;
}
