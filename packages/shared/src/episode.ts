import { z } from "zod";

/** ISO 8601 timestamp, e.g. `2026-11-11T09:30:00.000Z` (an explicit offset is also accepted). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** An http(s) URL. Hosts such as `localhost` are allowed (unlike zod's `httpUrl`). */
export const HttpUrlSchema = z.url({
  protocol: /^https?$/,
  error: "Invalid URL: expected an http(s) URL",
});

/** Non-negative whole milliseconds. */
const Ms = z.number().int().min(0);

/** BCP-47 language tag; the app mostly uses primary tags such as "en" and "hu". */
export const LangSchema = z
  .string()
  .regex(
    /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/,
    'Invalid language: expected a BCP-47 tag such as "en" or "hu"',
  );
export type Lang = z.infer<typeof LangSchema>;

export const ModeSchema = z.enum(["standard", "graded", "bilingual"]);
export type Mode = z.infer<typeof ModeSchema>;

export const LevelSchema = z.enum(["A1", "A2", "B1", "B2"]);
export type Level = z.infer<typeof LevelSchema>;

export const SegmentKindSchema = z.enum(["intro", "content", "explanation", "recap", "outro"]);
export type SegmentKind = z.infer<typeof SegmentKindSchema>;

export const SpeakerSchema = z.enum(["host", "teacher", "cohost"]);
export type Speaker = z.infer<typeof SpeakerSchema>;

export const MorphemeSchema = z.object({
  form: z.string().min(1), // "-ban"
  meaning: z.string().min(1), // "in"
});
export type Morpheme = z.infer<typeof MorphemeSchema>;

export const TokenSchema = z.object({
  surface: z.string().min(1), // "házamban"
  lemma: z.string().min(1), // "ház"
  pos: z.string().min(1), // "noun"
  gloss: z.string(), // "in my house": the meaning in this sentence
  morphemes: z.array(MorphemeSchema).optional(),
  isTarget: z.boolean().optional(), // new or due word this episode teaches
});
export type Token = z.infer<typeof TokenSchema>;

/** LLM output unit of the `script` stage. */
export const ScriptSegmentSchema = z.object({
  id: z.string().min(1), // "seg-0001"
  kind: SegmentKindSchema,
  speaker: SpeakerSchema,
  lang: LangSchema,
  text: z.string().min(1), // exactly what is spoken
  rate: z.number().min(0.7).max(1.1).optional(), // TTS speaking rate
  pauseAfterMs: Ms.optional(),
  sourceIds: z.array(z.string().min(1)).optional(), // grounding
  // learning modes only:
  translation: z.string().optional(), // into NATIVE_LANG
  tokens: z.array(TokenSchema).optional(),
  repeatOf: z.string().min(1).optional(), // bilingual: id of the sentence this one repeats
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

/** A script segment with its exact position in the assembled audio. */
export const EpisodeSegmentSchema = ScriptSegmentSchema.extend({
  startMs: Ms,
  endMs: Ms,
}).refine((segment) => segment.endMs >= segment.startMs, {
  path: ["endMs"],
  error: "endMs must not be before startMs",
});
export type EpisodeSegment = z.infer<typeof EpisodeSegmentSchema>;

export const EPISODE_SCHEMA_VERSION = 1;

export const EpisodeAudioSchema = z.object({
  file: z.literal("audio.m4a"),
  bytes: z.number().int().min(0),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "Invalid sha256: expected 64 lowercase hex characters"),
});
export type EpisodeAudio = z.infer<typeof EpisodeAudioSchema>;

export const ChapterSchema = z.object({ title: z.string().min(1), startMs: Ms });
export type Chapter = z.infer<typeof ChapterSchema>;

export const EpisodeSourceSchema = z.object({
  id: z.string().min(1), // "s3"
  url: HttpUrlSchema,
  title: z.string(),
  site: z.string(),
  publishedAt: z.string().optional(), // as reported by the page; format not guaranteed
});
export type EpisodeSource = z.infer<typeof EpisodeSourceSchema>;

export const TargetVocabularySchema = z.object({ lemma: z.string().min(1), gloss: z.string() });
export type TargetVocabulary = z.infer<typeof TargetVocabularySchema>;

export const GenerationInfoSchema = z.object({
  profile: z.string(),
  llm: z.string(),
  tts: z.string(),
  voice: z.string(),
  // Tracked LLM estimates only; excludes TTS and unmetered usage, not total cost.
  // Older episodes may contain a zero placeholder rather than tracked estimates.
  costUsd: z.number().min(0),
});
export type GenerationInfo = z.infer<typeof GenerationInfoSchema>;

/** The contents of `episode.json`. */
export const EpisodeSchema = z.object({
  schemaVersion: z.literal(EPISODE_SCHEMA_VERSION, {
    error: `Unsupported schemaVersion: expected ${EPISODE_SCHEMA_VERSION}`,
  }),
  id: z.string().min(1),
  topicId: z.string().min(1).optional(),
  title: z.string().min(1),
  summary: z.string(),
  createdAt: IsoDateTimeSchema,
  durationMs: Ms,
  mode: ModeSchema,
  lang: LangSchema,
  nativeLang: LangSchema,
  level: LevelSchema.optional(),
  audio: EpisodeAudioSchema,
  segments: z.array(EpisodeSegmentSchema),
  chapters: z.array(ChapterSchema),
  sources: z.array(EpisodeSourceSchema),
  targetVocabulary: z.array(TargetVocabularySchema).optional(),
  generation: GenerationInfoSchema,
});
export type Episode = z.infer<typeof EpisodeSchema>;
