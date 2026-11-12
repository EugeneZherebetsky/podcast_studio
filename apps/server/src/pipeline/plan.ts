// Stage 1, `plan`: topic -> plan.json (search queries, angle, target word count).
import type { Lang, Level, Mode } from "shared";
import type { LlmProvider } from "../providers/llm/interface.ts";
import { runCachedStage, type StageResult } from "./artifacts.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { MAX_QUERIES, MIN_QUERIES, PlanResponseSchema, PlanSchema, type Plan } from "./schemas.ts";

export interface PreviousEpisode {
  title: string;
  summary: string;
}

export interface PlanInput {
  title: string;
  brief: string;
  lang: Lang;
  mode: Mode;
  level?: Level;
  minutes: number;
  /** Recurring topics: the topic's latest episodes (the runner passes the last 5). */
  previousEpisodes?: readonly PreviousEpisode[];
}

export interface PlanDeps {
  workDir: string;
  llm: LlmProvider;
}

/** Spoken words per minute (ARCHITECTURE §3 row 5): graded speech is slower. */
const WORDS_PER_MINUTE = { standard: 140, graded: 90 } as const;

export function targetWordCount(mode: Mode, minutes: number): number {
  const rate = mode === "graded" ? WORDS_PER_MINUTE.graded : WORDS_PER_MINUTE.standard;
  return Math.round(minutes * rate);
}

function listPreviousEpisodes(episodes: readonly PreviousEpisode[]): string {
  if (episodes.length === 0) return "(none)";
  return episodes
    .map((episode, i) => `${i + 1}. ${episode.title.trim()}: ${episode.summary.trim()}`)
    .join("\n");
}

export async function runPlanStage(deps: PlanDeps, input: PlanInput): Promise<StageResult<Plan>> {
  const template = loadPrompt("plan");
  const previousEpisodes = input.previousEpisodes ?? [];
  const wordCount = targetWordCount(input.mode, input.minutes);

  return runCachedStage({
    workDir: deps.workDir,
    stage: "plan",
    // The template is an input too: editing a prompt re-runs the stage.
    inputs: { ...input, previousEpisodes, template },
    schema: PlanSchema,
    run: async () => {
      const { system, prompt } = renderPrompt(
        template,
        {
          title: input.title,
          brief: input.brief.trim() === "" ? "(none)" : input.brief,
          language: input.lang,
          mode: input.mode,
          level: input.level ?? "(not set)",
          minutes: String(input.minutes),
          targetWordCount: String(wordCount),
          minQueries: String(MIN_QUERIES),
          maxQueries: String(MAX_QUERIES),
          previousEpisodes: listPreviousEpisodes(previousEpisodes),
        },
        "plan",
      );
      const { object, usage } = await deps.llm.generateObject({
        slot: "fast",
        system,
        prompt,
        schema: PlanResponseSchema,
      });
      return { artifact: { ...object, targetWordCount: wordCount }, usage: [usage] };
    },
  });
}
