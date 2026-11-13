// Stage 4, `notes`: each source -> fact bullets tagged with its id (map), then one merged
// outline whose facts keep their source ids -> notes.json. Source text is untrusted: it is
// wrapped in <source> tags, and these calls carry no tools.
import { CancelledAfterStage } from "./cancellation.ts";
import { ExternalWorkUncertain } from "./runner.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider, Usage } from "../providers/llm/interface.ts";
import { hashInputs, runCachedStage, SCRATCH_FILES, type StageResult } from "./artifacts.ts";
import { escapeSourceText, loadPrompt, renderPrompt } from "./prompts.ts";
import {
  NotesSchema,
  outlineResponseSchemaFor,
  SourceFactsResponseSchema,
  type Notes,
  type Plan,
  type SourceFact,
  type Sources,
} from "./schemas.ts";

export interface NotesInput {
  /** The topic title. */
  title: string;
  plan: Plan;
  sources: Sources;
  /** Map calls made at the same time. Default 3. Does not affect the result. */
  concurrency?: number;
}

export interface NotesDeps {
  workDir: string;
  llm: LlmProvider;
  shouldContinue?: () => boolean;
  assertContinue?: () => void;
  onProgress?: (progress: import("../job-log.ts").Progress) => void;
}

const DEFAULT_CONCURRENCY = 3;

export async function runNotesStage(
  deps: NotesDeps,
  input: NotesInput,
): Promise<StageResult<Notes>> {
  const mapTemplate = loadPrompt("notes-map");
  const mergeTemplate = loadPrompt("notes-merge");
  const { title, plan } = input;
  const { sources } = input.sources;

  return runCachedStage({
    workDir: deps.workDir,
    stage: "notes",
    inputs: {
      title,
      plan,
      sources,
      model: deps.llm.cacheIdentity ?? deps.llm.localCacheIdentity,
      templates: { map: mapTemplate, merge: mergeTemplate },
    },
    schema: NotesSchema,
    run: async () => {
      const limit = deps.llm.localCacheIdentity ? 1 : (input.concurrency ?? DEFAULT_CONCURRENCY);
      if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid notes concurrency");
      const mapped: Array<{ object: { facts: string[] }; usage?: Usage }> = [];
      let next = 0;
      let failed = false;
      let failure: unknown;
      const worker = async () => {
        while (!failed && next < sources.length) {
          const i = next++;
          const source = sources[i]!;
          const { system, prompt } = renderPrompt(
            mapTemplate,
            {
              title,
              angle: plan.angle,
              sourceId: source.id,
              sourceTitle: escapeSourceText(source.title),
              sourceSite: escapeSourceText(source.site),
              sourcePublishedAt: escapeSourceText(source.publishedAt ?? "unknown"),
              sourceText: escapeSourceText(source.text),
            },
            "notes-map",
          );
          const key = hashInputs({
            version: 1,
            model: deps.llm.localCacheIdentity,
            source,
            system,
            prompt,
          });
          const cacheDir = path.join(deps.workDir, SCRATCH_FILES.notesMap);
          const file = path.join(cacheDir, `${key}.json`);
          const started = Date.now();
          try {
            deps.assertContinue?.();
            if (deps.shouldContinue && !deps.shouldContinue())
              throw new Error("Job cancelled during notes");
            let object: { facts: string[] } | undefined;
            if (deps.llm.localCacheIdentity) {
              try {
                const parsed = SourceFactsResponseSchema.safeParse(
                  JSON.parse(await readFile(file, "utf8")),
                );
                if (parsed.success) object = parsed.data;
              } catch {
                /* Missing or corrupt entry: regenerate. */
              }
            }
            if (object) {
              deps.onProgress?.({ kind: "map", status: "cached", index: i + 1, total: sources.length });
              console.info(`[notes] map ${i + 1}/${sources.length} cache hit`);
              mapped[i] = { object };
              continue;
            }
            console.info(`[notes] map ${i + 1}/${sources.length} started`);
            deps.onProgress?.({ kind: "map", status: "started", index: i + 1, total: sources.length });
            const result = await deps.llm.generateObject({
              slot: "fast",
              system,
              prompt,
              schema: SourceFactsResponseSchema,
            });
            if (deps.llm.localCacheIdentity) {
              const parsed = SourceFactsResponseSchema.parse(result.object);
              await mkdir(cacheDir, { recursive: true });
              const temp = `${file}.${randomUUID()}.tmp`;
              try {
                await writeFile(temp, JSON.stringify(parsed), "utf8");
                await rename(temp, file);
              } finally {
                await rm(temp, { force: true });
              }
            }
            mapped[i] = result;
            deps.onProgress?.({ kind: "map", status: "done", index: i + 1, total: sources.length, elapsedMs: Date.now() - started });
            console.info(
              `[notes] map ${i + 1}/${sources.length} completed in ${Date.now() - started}ms`,
            );
          } catch (error) {
            deps.onProgress?.({ kind: "map", status: "failed", index: i + 1, total: sources.length, elapsedMs: Date.now() - started });
            console.info(
              `[notes] map ${i + 1}/${sources.length} failed after ${Date.now() - started}ms`,
            );
            if (!failed || (!(failure instanceof ExternalWorkUncertain) && error instanceof ExternalWorkUncertain) ||
              (failure instanceof CancelledAfterStage && !(error instanceof CancelledAfterStage))) failure = error;
            failed = true;
          }
        }
      };
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(limit, sources.length) }, worker),
      );
      const unexpected = settled.find((result) => result.status === "rejected");
      if (unexpected?.status === "rejected") throw unexpected.reason;
      if (failed) throw failure;

      const usage: Usage[] = mapped.flatMap((result) => (result.usage ? [result.usage] : []));
      const facts: SourceFact[] = mapped.flatMap((result, i) =>
        result.object.facts.map((text) => ({ sourceId: sources[i]!.id, text })),
      );
      if (facts.length === 0) {
        throw new Error(
          `No facts could be taken from the ${sources.length} sources for "${title}". ` +
            `The pages may be off topic: try a more specific brief.`,
        );
      }

      const { system, prompt } = renderPrompt(
        mergeTemplate,
        {
          title,
          angle: plan.angle,
          facts: facts
            .map((fact) => `- [${fact.sourceId}] ${escapeSourceText(fact.text)}`)
            .join("\n"),
        },
        "notes-merge",
      );
      deps.assertContinue?.();
      if (deps.shouldContinue && !deps.shouldContinue())
        throw new Error("Job cancelled during notes");
      const mergeStarted = Date.now();
      console.info("[notes] merge started");
      deps.onProgress?.({ kind: "merge", status: "started" });
      const merged = await deps.llm.generateObject({
        slot: "fast",
        system,
        prompt,
        ...(deps.llm.localCacheIdentity ? { localTimeoutMs: 900_000 } : {}),
        schema: outlineResponseSchemaFor(sources.map((source) => source.id)),
      }).catch((error: unknown) => {
        deps.onProgress?.({ kind: "merge", status: "failed", elapsedMs: Date.now() - mergeStarted });
        throw error;
      });
      deps.onProgress?.({ kind: "merge", status: "done", elapsedMs: Date.now() - mergeStarted });
      console.info(`[notes] merge completed in ${Date.now() - mergeStarted}ms`);
      if (merged.usage) usage.push(merged.usage);

      return { artifact: { facts, outline: merged.object.outline }, usage };
    },
  });
}
