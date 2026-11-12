// Artifact schemas of the research stages (plan, search, extract, notes). They are work
// files of a job, not part of the episode format or the HTTP API, so they live here and
// not in `packages/shared`.
import { z } from "zod";

const Text = z.string().trim().min(1);

/** Source ids are assigned by stage `extract`: "s1", "s2", … */
export const SourceIdSchema = z.string().regex(/^s[1-9]\d*$/, {
  error: 'Invalid source id: expected "s1", "s2", …',
});

// --- plan.json -------------------------------------------------------------------------

export const MIN_QUERIES = 5;
export const MAX_QUERIES = 8;

/** What the model is asked for; the word budget is computed, not generated. */
export const PlanResponseSchema = z.object({
  queries: z
    .array(Text)
    .min(MIN_QUERIES)
    .max(MAX_QUERIES)
    .describe("Web search queries, each covering a different part of the topic"),
  angle: Text.describe("One or two sentences: the angle this episode takes on the topic"),
});
export type PlanResponse = z.infer<typeof PlanResponseSchema>;

export const PlanSchema = PlanResponseSchema.extend({
  targetWordCount: z.number().int().positive(),
});
export type Plan = z.infer<typeof PlanSchema>;

// --- candidates.json -------------------------------------------------------------------

export const CandidateSchema = z.object({
  url: z.string().min(1), // canonical
  title: z.string(),
  snippet: z.string(),
  publishedAt: z.string().min(1).optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidatesSchema = z.object({ candidates: z.array(CandidateSchema) });
export type Candidates = z.infer<typeof CandidatesSchema>;

// --- sources.json ----------------------------------------------------------------------

export const MAX_SOURCE_TEXT_CHARS = 8000;
export const MIN_USABLE_SOURCES = 3;

export const SourceSchema = z.object({
  id: SourceIdSchema,
  url: z.string().min(1),
  title: z.string().min(1),
  site: z.string(),
  publishedAt: z.string().min(1).optional(),
  text: z.string().min(1).max(MAX_SOURCE_TEXT_CHARS),
});
export type Source = z.infer<typeof SourceSchema>;

export const SourcesSchema = z.object({ sources: z.array(SourceSchema).min(MIN_USABLE_SOURCES) });
export type Sources = z.infer<typeof SourcesSchema>;

// --- notes.json ------------------------------------------------------------------------

/** Map step, one call per source. The stage itself tags each fact with the source id. */
export const SourceFactsResponseSchema = z.object({
  facts: z
    .array(Text)
    .max(15)
    .describe("Self-contained factual statements found in the source; empty if it has none"),
});
export type SourceFactsResponse = z.infer<typeof SourceFactsResponseSchema>;

export const SourceFactSchema = z.object({ sourceId: SourceIdSchema, text: Text });
export type SourceFact = z.infer<typeof SourceFactSchema>;

export const OutlineFactSchema = z
  .object({
    text: Text,
    sourceIds: z.array(SourceIdSchema).min(1).describe("Ids of the sources that state this fact"),
    conflict: Text.optional().describe(
      "Only when sources disagree: what each one says. List every disagreeing source in sourceIds",
    ),
  })
  .refine((fact) => fact.conflict === undefined || new Set(fact.sourceIds).size >= 2, {
    path: ["conflict"],
    error: "Invalid conflict: a conflicting fact must cite at least two different sources",
  });
export type OutlineFact = z.infer<typeof OutlineFactSchema>;

export const OutlineSectionSchema = z.object({
  heading: Text,
  facts: z.array(OutlineFactSchema).min(1),
});
export type OutlineSection = z.infer<typeof OutlineSectionSchema>;

export const OutlineResponseSchema = z.object({ outline: z.array(OutlineSectionSchema).min(1) });
export type OutlineResponse = z.infer<typeof OutlineResponseSchema>;

/** The merge response, additionally limited to source ids that really exist. */
export function outlineResponseSchemaFor(knownSourceIds: Iterable<string>) {
  const known = new Set(knownSourceIds);
  return OutlineResponseSchema.superRefine((response, context) => {
    response.outline.forEach((section, sectionIndex) => {
      section.facts.forEach((fact, factIndex) => {
        fact.sourceIds.forEach((id, idIndex) => {
          if (known.has(id)) return;
          context.addIssue({
            code: "custom",
            path: ["outline", sectionIndex, "facts", factIndex, "sourceIds", idIndex],
            message: `Unknown source id "${id}": expected one of ${[...known].join(", ")}`,
          });
        });
      });
    });
  });
}

export const NotesSchema = z.object({
  /** Every fact of the map step, in source order. */
  facts: z.array(SourceFactSchema).min(1),
  /** The merged outline; each fact keeps the ids of the sources behind it. */
  outline: z.array(OutlineSectionSchema).min(1),
});
export type Notes = z.infer<typeof NotesSchema>;
