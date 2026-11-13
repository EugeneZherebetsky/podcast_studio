import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashInputs, runCachedStage, SCRATCH_FILES, type StageResult } from "./artifacts.ts";
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

async function runLocalReview(deps: ScriptDeps, input: ReviewInput, scriptInput: ScriptInput) {
  const template = loadPrompt("local-review");
  responseSchemaFor(scriptInput).parse(input.script);
  ScriptSchema.parse(input.script);
  if (input.script.segments.some((s, i) => s.id !== `seg-${String(i + 1).padStart(4, "0")}`))
    throw new Error("Review requires continuous original segment IDs");
  const segments: Script["segments"] = [];
  const findings: Review["findings"] = [];
  const usage: StageResult<Review>["usage"] = [];
  const words = (text: string) => text.trim().split(/\s+/u).length;
  for (const [index, segment] of input.script.segments.entries()) {
    const ids = new Set(segment.sourceIds ?? []);
    const evidence = ids.size
      ? { facts: input.notes.facts.filter((fact) => ids.has(fact.sourceId)) }
      : { outline: input.notes.outline };
    if (ids.size && [...ids].some((id) => !input.notes.facts.some((fact) => fact.sourceId === id)))
      throw new Error(`Missing evidence for segment ${segment.id}`);
    const otherWords = [...segments, ...input.script.segments.slice(index + 1)].reduce(
      (sum, item) => sum + words(item.text),
      0,
    );
    const schema = z
      .object({
        text: z
          .string()
          .trim()
          .min(1)
          .max(segment.text.length * 2 + 200),
        findings: z
          .array(
            FindingSchema.extend({
              claim: z.string().min(1).max(500),
              reason: z.string().min(1).max(500),
            }),
          )
          .max(12),
      })
      .superRefine((part, ctx) => {
        const total = otherWords + words(part.text);
        if (total < input.plan.targetWordCount * 0.8 || total > input.plan.targetWordCount * 1.2)
          ctx.addIssue({
            code: "custom",
            message: `Word count ${total} would exceed the episode budget`,
          });
        for (const finding of part.findings)
          if (finding.segmentId !== segment.id)
            ctx.addIssue({ code: "custom", message: `Finding must refer to ${segment.id}` });
      });
    const { system, prompt } = renderPrompt(
      template,
      {
        budget: `${Math.max(1, Math.ceil(input.plan.targetWordCount * 0.8 - otherWords))}–${Math.floor(input.plan.targetWordCount * 1.2 - otherWords)} words (original: ${words(segment.text)})`,
        notes: escapeSourceText(JSON.stringify(evidence)),
        script: escapeSourceText(JSON.stringify(segment)),
      },
      "local-review",
    );
    const key = hashInputs({
      version: 1,
      model: deps.llm.localCacheIdentity,
      input,
      otherWords,
      system,
      prompt,
      schema: z.toJSONSchema(schema),
    });
    const dir = path.join(deps.workDir, SCRATCH_FILES.reviewSegments);
    const file = path.join(dir, `${key}.json`);
    let part: z.infer<typeof schema> | undefined;
    try {
      const cached = schema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (cached.success) part = cached.data;
    } catch {
      // Missing or damaged entries are regenerated.
    }
    if (!part) {
      const result = await deps.llm.generateObject({
        slot: "main",
        system,
        prompt,
        schema,
        localTimeoutMs: 900_000,
      });
      part = schema.parse(result.object);
      usage.push(result.usage);
      await mkdir(dir, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(part), "utf8");
        await rename(temp, file);
      } finally {
        await rm(temp, { force: true });
      }
    }
    segments.push({ ...segment, text: part.text });
    findings.push(...part.findings);
  }
  const script = ScriptSchema.parse({ ...input.script, segments });
  responseSchemaFor(scriptInput).parse(script);
  return { artifact: { script, findings, skipped: false }, usage };
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
  const storedSchema = ReviewSchema.superRefine((review, ctx) => {
    if (!deps.llm.localCacheIdentity || input.noReview) return;
    const valid = responseSchemaFor(scriptInput).safeParse(review.script);
    if (!valid.success) ctx.addIssue({ code: "custom", message: "Invalid reviewed script" });
    if (
      review.skipped ||
      hashInputs({ ...review.script, segments: input.script.segments }) !==
        hashInputs(input.script) ||
      review.script.segments.length !== input.script.segments.length ||
      review.script.segments.some(
        (segment, i) =>
          hashInputs({ ...segment, text: input.script.segments[i]?.text }) !==
          hashInputs(input.script.segments[i]),
      ) ||
      review.findings.some(
        (finding) => !input.script.segments.some((segment) => segment.id === finding.segmentId),
      )
    )
      ctx.addIssue({ code: "custom", message: "Review changed script structure" });
  });
  const result = await runCachedStage({
    workDir: deps.workDir,
    stage: "review",
    inputs: {
      ...input,
      template,
      ...(deps.llm.localCacheIdentity
        ? {
            localModel: deps.llm.localCacheIdentity,
            localTemplate: loadPrompt("local-review"),
            localReviewVersion: 1,
          }
        : {}),
    },
    schema: storedSchema,
    run: async () => {
      if (input.noReview)
        return { artifact: { script: input.script, findings: [], skipped: true }, usage: [] };
      if (deps.llm.localCacheIdentity) return runLocalReview(deps, input, scriptInput);
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
        ...(deps.llm.localCacheIdentity ? { localTimeoutMs: 900_000 } : {}),
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
  const file = path.join(deps.workDir, SCRATCH_FILES.reviewedScript);
  const content = `${JSON.stringify(result.artifact.script, null, 2)}\n`;
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing !== content) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, content, "utf8");
    await rename(temp, file);
  }
  return result;
}
