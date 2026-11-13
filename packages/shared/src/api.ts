// Topic, job and HTTP API contracts (docs/ARCHITECTURE.md §4 "SQLite tables" and §6).
// Route paths below are relative to the `/api` prefix.
import { z } from "zod";
import {
  EpisodeSchema,
  IsoDateTimeSchema,
  LangSchema,
  LevelSchema,
  ModeSchema,
} from "./episode.ts";

const Id = z.string().min(1);
const Title = z.string().trim().min(1);
const Minutes = z.number().int().min(1).max(120);
const Ms = z.number().int().min(0);

export const ProfileSchema = z.enum(["cloud", "local"]);
export type Profile = z.infer<typeof ProfileSchema>;

// ---------------------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------------------

export const TopicSchema = z.object({
  id: Id,
  title: Title,
  brief: z.string(),
  mode: ModeSchema,
  lang: LangSchema,
  level: LevelSchema.nullable(),
  minutes: Minutes,
  schedule: z.string().min(1).nullable(), // cron expression; null = not recurring
  enabled: z.boolean(),
  lastRunAt: IsoDateTimeSchema.nullable(),
});
export type Topic = z.infer<typeof TopicSchema>;

// ---------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------

/** Pipeline stages in execution order. */
export const STAGE_NAMES = [
  "plan",
  "search",
  "extract",
  "notes",
  "script",
  "review",
  "tts",
  "assemble",
  "publish",
] as const;
export const StageNameSchema = z.enum(STAGE_NAMES);
export type StageName = z.infer<typeof StageNameSchema>;

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobStageStatusSchema = z.enum(["pending", "running", "done", "skipped", "failed"]);
export type JobStageStatus = z.infer<typeof JobStageStatusSchema>;

export const GranularitySchema = z.enum(["sentence", "paragraph"]);
export type Granularity = z.infer<typeof GranularitySchema>;

/** What to generate. Stored on the job; also the ad-hoc body of `POST /jobs`. */
export const JobOptionsSchema = z.object({
  title: Title,
  brief: z.string().default(""),
  mode: ModeSchema,
  lang: LangSchema,
  level: LevelSchema.optional(),
  minutes: Minutes,
  granularity: GranularitySchema.optional(), // default depends on the mode
  review: z.boolean().optional(), // false skips the review stage
});
export type JobOptions = z.infer<typeof JobOptionsSchema>;

export const JobSchema = z.object({
  id: Id,
  topicId: Id.nullable(),
  status: JobStatusSchema,
  currentStage: StageNameSchema.nullable(),
  error: z.string().nullable(),
  options: JobOptionsSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Job = z.infer<typeof JobSchema>;

export const JobStageSchema = z.object({
  jobId: Id,
  stage: StageNameSchema,
  status: JobStageStatusSchema,
  inputHash: z.string().nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  error: z.string().nullable(),
});
export type JobStage = z.infer<typeof JobStageSchema>;

/** A job with its per-stage status. */
export const JobDetailSchema = JobSchema.extend({ stages: z.array(JobStageSchema) });
export type JobDetail = z.infer<typeof JobDetailSchema>;

// ---------------------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------------------

/** Path parameters of every `/:id` route. */
export const IdParamsSchema = z.object({ id: Id });
export type IdParams = z.infer<typeof IdParamsSchema>;

/** Body of a successful request that has nothing else to return (deletes, playback sync). */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** Body of every non-2xx response. */
export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------------------

export const ProviderHealthSchema = z.object({ name: z.string(), reachable: z.boolean() });
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const HealthResponseSchema = z.object({
  version: z.string(),
  profile: ProfileSchema,
  providers: z.object({
    llm: ProviderHealthSchema,
    search: ProviderHealthSchema,
    tts: ProviderHealthSchema,
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---------------------------------------------------------------------------------------
// GET/POST /topics, PATCH/DELETE /topics/:id
// ---------------------------------------------------------------------------------------

export const ListTopicsResponseSchema = z.object({ topics: z.array(TopicSchema) });
export type ListTopicsResponse = z.infer<typeof ListTopicsResponseSchema>;

/** `POST /topics` request. Response: {@link TopicSchema}. */
export const CreateTopicRequestSchema = z.object({
  title: Title,
  brief: z.string().default(""),
  mode: ModeSchema,
  lang: LangSchema,
  level: LevelSchema.nullable().optional(),
  minutes: Minutes,
  schedule: z.string().min(1).nullable().optional(),
  enabled: z.boolean().default(true),
});
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;
export type CreateTopicRequestInput = z.input<typeof CreateTopicRequestSchema>;

/** `PATCH /topics/:id` request: any subset of the editable fields. Response: {@link TopicSchema}. */
export const UpdateTopicRequestSchema = z
  .object({
    title: Title,
    brief: z.string(),
    mode: ModeSchema,
    lang: LangSchema,
    level: LevelSchema.nullable(),
    minutes: Minutes,
    schedule: z.string().min(1).nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    error: "Invalid update: expected at least one field to change",
  });
export type UpdateTopicRequest = z.infer<typeof UpdateTopicRequestSchema>;

// `DELETE /topics/:id` response: OkResponseSchema.

// ---------------------------------------------------------------------------------------
// POST /jobs, GET /jobs, GET /jobs/:id, POST /jobs/:id/retry, POST /jobs/:id/cancel
// ---------------------------------------------------------------------------------------

/** `POST /jobs` request: run an existing topic, or an ad-hoc one. Response: {@link JobSchema}. */
export const CreateJobRequestSchema = z.union([z.object({ topicId: Id }), JobOptionsSchema]);
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;
export type CreateJobRequestInput = z.input<typeof CreateJobRequestSchema>;

export const ListJobsResponseSchema = z.object({ jobs: z.array(JobSchema) });
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;

// `GET /jobs/:id` response: JobDetailSchema.

/** `POST /jobs/:id/retry` request. Without `fromStage` the job resumes at its failed stage. */
export const RetryJobRequestSchema = z.object({ fromStage: StageNameSchema.optional() });
export type RetryJobRequest = z.infer<typeof RetryJobRequestSchema>;

// `POST /jobs/:id/retry` and `POST /jobs/:id/cancel` responses: JobSchema.

// ---------------------------------------------------------------------------------------
// GET /events (SSE): the JSON payload of each `data:` line
// ---------------------------------------------------------------------------------------

export const JobStageEventSchema = z.object({
  type: z.literal("job-stage"),
  jobId: Id,
  stage: StageNameSchema,
  status: JobStageStatusSchema,
  error: z.string().optional(),
});
export type JobStageEvent = z.infer<typeof JobStageEventSchema>;

export const EpisodeReadyEventSchema = z.object({
  type: z.literal("episode-ready"),
  jobId: Id,
  episodeId: Id,
});
export type EpisodeReadyEvent = z.infer<typeof EpisodeReadyEventSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  JobStageEventSchema,
  EpisodeReadyEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ---------------------------------------------------------------------------------------
// GET /episodes?since=<iso>, GET /episodes/:id, DELETE /episodes/:id
// ---------------------------------------------------------------------------------------

export const ListEpisodesQuerySchema = z.object({ since: IsoDateTimeSchema.optional() });
export type ListEpisodesQuery = z.infer<typeof ListEpisodesQuerySchema>;

/** Library row: the `episodes` table without the server-side path. */
export const EpisodeSummarySchema = z.object({
  id: Id,
  topicId: Id.nullable(),
  title: z.string().min(1),
  summary: z.string(),
  mode: ModeSchema,
  lang: LangSchema,
  durationMs: Ms,
  createdAt: IsoDateTimeSchema,
});
export type EpisodeSummary = z.infer<typeof EpisodeSummarySchema>;

export const ListEpisodesResponseSchema = z.object({ episodes: z.array(EpisodeSummarySchema) });
export type ListEpisodesResponse = z.infer<typeof ListEpisodesResponseSchema>;

/** `GET /episodes/:id` response: the full `episode.json`. */
export const GetEpisodeResponseSchema = EpisodeSchema;
export type GetEpisodeResponse = z.infer<typeof GetEpisodeResponseSchema>;

// `GET /episodes/:id/audio` returns audio bytes, not JSON.
// `DELETE /episodes/:id` response: OkResponseSchema.

// ---------------------------------------------------------------------------------------
// POST /pair/start, POST /pair/complete
// ---------------------------------------------------------------------------------------

/** `POST /pair/start` response (no request body): the text to render as a QR code. */
export const PairStartResponseSchema = z.object({ qr: z.string().min(1) });
export type PairStartResponse = z.infer<typeof PairStartResponseSchema>;

export const PairCompleteRequestSchema = z.object({
  code: z.string().min(1),
  deviceName: z.string().trim().min(1),
});
export type PairCompleteRequest = z.infer<typeof PairCompleteRequestSchema>;

export const PairCompleteResponseSchema = z.object({ token: z.string().min(1) });
export type PairCompleteResponse = z.infer<typeof PairCompleteResponseSchema>;

// ---------------------------------------------------------------------------------------
// POST /sync/playback, POST /sync/vocab
// ---------------------------------------------------------------------------------------

/** One playback position; the device is identified by the bearer token. */
export const PlaybackPositionSchema = z.object({
  episodeId: Id,
  positionMs: Ms,
  finished: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type PlaybackPosition = z.infer<typeof PlaybackPositionSchema>;

/** `POST /sync/playback` request. Response: {@link OkResponseSchema}. */
export const SyncPlaybackRequestSchema = z.object({ positions: z.array(PlaybackPositionSchema) });
export type SyncPlaybackRequest = z.infer<typeof SyncPlaybackRequestSchema>;

export const VocabStateSchema = z.enum(["new", "learning", "review", "relearning"]);
export type VocabState = z.infer<typeof VocabStateSchema>;

export const VocabCardSchema = z.object({
  lemma: z.string().min(1),
  lang: LangSchema,
  gloss: z.string(),
  state: VocabStateSchema,
  dueAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  card: z.record(z.string(), z.unknown()), // raw FSRS card JSON, opaque to the server
});
export type VocabCard = z.infer<typeof VocabCardSchema>;

export const SyncVocabRequestSchema = z.object({ cards: z.array(VocabCardSchema) });
export type SyncVocabRequest = z.infer<typeof SyncVocabRequestSchema>;

/** `POST /sync/vocab` response: the server's rows that are newer than the ones sent. */
export const SyncVocabResponseSchema = z.object({ cards: z.array(VocabCardSchema) });
export type SyncVocabResponse = z.infer<typeof SyncVocabResponseSchema>;

// ---------------------------------------------------------------------------------------
// GET/PUT /settings
// ---------------------------------------------------------------------------------------

const voiceFields = {
  huHost: z.string().min(1).nullable(),
  huCohost: z.string().min(1).nullable(),
  nativeHost: z.string().min(1).nullable(),
  nativeTeacher: z.string().min(1).nullable(),
};

const settingsFields = {
  profile: ProfileSchema,
  nativeLang: LangSchema,
  targetLang: LangSchema,
  level: LevelSchema,
  monthlyBudgetUsd: z.number().min(0),
  cloudTts: z.discriminatedUnion("provider", [
    z.strictObject({ provider: z.literal("elevenlabs"), model: z.enum(["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_v3"]), voice: z.string().trim().min(1).max(128), inputLimit: z.number().int().min(1).max(100000) }),
    z.strictObject({ provider: z.literal("fish"), model: z.enum(["s1", "s2-pro", "s2.1-pro", "s2.1-pro-free", "drama-3"]), voice: z.string().trim().min(1).max(128), inputLimit: z.number().int().min(1).max(100000) }),
  ]).nullable().optional(),
};

/**
 * `GET /settings` and `PUT /settings` response. Strict on purpose: settings never carry
 * secrets, so a body with any unknown key (an API key, say) fails validation.
 */
export const SettingsSchema = z.strictObject({
  ...settingsFields,
  voices: z.strictObject(voiceFields),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** `PUT /settings` request: any subset of the settings. */
export const UpdateSettingsRequestSchema = z
  .strictObject({
    ...settingsFields,
    voices: z.strictObject(voiceFields).partial(),
  })
  .partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;

// ---------------------------------------------------------------------------------------
// GET /feed.xml?token=
// ---------------------------------------------------------------------------------------

/** Query of the optional RSS feed; the response is XML. */
export const FeedQuerySchema = z.object({ token: z.string().min(1) });
export type FeedQuery = z.infer<typeof FeedQuerySchema>;
