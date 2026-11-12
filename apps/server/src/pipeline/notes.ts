// Stage 4, `notes`: each source -> fact bullets tagged with its id (map), then one merged
// outline whose facts keep their source ids -> notes.json. Source text is untrusted: it is
// wrapped in <source> tags, and these calls carry no tools.
import type { LlmProvider, Usage } from "../providers/llm/interface.ts";
import { ConcurrencyLimiter } from "../providers/tts/cache.ts";
import { runCachedStage, type StageResult } from "./artifacts.ts";
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
    inputs: { title, plan, sources, templates: { map: mapTemplate, merge: mergeTemplate } },
    schema: NotesSchema,
    run: async () => {
      const limiter = new ConcurrencyLimiter(input.concurrency ?? DEFAULT_CONCURRENCY);
      const mapped = await Promise.all(
        sources.map((source) =>
          limiter.run(async () => {
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
            return deps.llm.generateObject({
              slot: "fast",
              system,
              prompt,
              schema: SourceFactsResponseSchema,
            });
          }),
        ),
      );

      const usage: Usage[] = mapped.map((result) => result.usage);
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
      const merged = await deps.llm.generateObject({
        slot: "fast",
        system,
        prompt,
        schema: outlineResponseSchemaFor(sources.map((source) => source.id)),
      });
      usage.push(merged.usage);

      return { artifact: { facts, outline: merged.object.outline }, usage };
    },
  });
}
