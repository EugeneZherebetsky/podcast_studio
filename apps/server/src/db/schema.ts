import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  JobOptions,
  JobStageStatus,
  JobStatus,
  Level,
  Mode,
  StageName,
  VocabState,
} from "shared";

// SQLite tables of the server (ARCHITECTURE §4). Conventions:
// - ids are text; timestamps are ISO 8601 text, as in the shared schemas;
// - booleans are 0/1 integers; JSON columns are text;
// - enum-like columns are plain text typed with the shared types. The values are validated
//   by the shared zod schemas at the edges, not by CHECK constraints.
// After changing this file run `pnpm --filter server db:generate` and commit the migration.

export const topics = sqliteTable("topics", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  brief: text("brief").notNull().default(""),
  mode: text("mode").$type<Mode>().notNull(),
  lang: text("lang").notNull(),
  level: text("level").$type<Level>(),
  minutes: integer("minutes").notNull(),
  /** Cron expression; null = not recurring. */
  schedule: text("schedule"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: text("last_run_at"),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** Null for ad-hoc jobs, and after the topic is deleted. */
    topicId: text("topic_id").references(() => topics.id, { onDelete: "set null" }),
    status: text("status").$type<JobStatus>().notNull(),
    currentStage: text("current_stage").$type<StageName>(),
    error: text("error"),
    options: text("options", { mode: "json" }).$type<JobOptions>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("jobs_status_idx").on(table.status)],
);

export const jobStages = sqliteTable(
  "job_stages",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    stage: text("stage").$type<StageName>().notNull(),
    status: text("status").$type<JobStageStatus>().notNull(),
    inputHash: text("input_hash"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    error: text("error"),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.stage] })],
);

export const episodes = sqliteTable(
  "episodes",
  {
    id: text("id").primaryKey(),
    topicId: text("topic_id").references(() => topics.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    mode: text("mode").$type<Mode>().notNull(),
    lang: text("lang").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: text("created_at").notNull(),
    /** Location of the episode package (audio.m4a + episode.json) on the server. */
    path: text("path").notNull(),
  },
  (table) => [index("episodes_created_at_idx").on(table.createdAt)],
);

/** Sources a topic has already used, so recurring runs do not repeat them. */
export const usedSources = sqliteTable(
  "used_sources",
  {
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    canonicalUrl: text("canonical_url").notNull(),
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.topicId, table.canonicalUrl] })],
);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at"),
});

export const vocab = sqliteTable(
  "vocab",
  {
    lemma: text("lemma").notNull(),
    lang: text("lang").notNull(),
    gloss: text("gloss").notNull(),
    state: text("state").$type<VocabState>().notNull(),
    dueAt: text("due_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** Raw FSRS card JSON, opaque to the server. */
    card: text("card", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.lemma, table.lang] })],
);

export const playback = sqliteTable(
  "playback",
  {
    episodeId: text("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    positionMs: integer("position_ms").notNull(),
    finished: integer("finished", { mode: "boolean" }).notNull().default(false),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.episodeId, table.deviceId] })],
);

/** One row per billable provider call; summed for the monthly cost guard. */
export const usage = sqliteTable(
  "usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    provider: text("provider").notNull(),
    /** What was used, e.g. "llm", "search", "tts". */
    kind: text("kind").notNull(),
    /** Tokens, queries or characters, depending on the kind. */
    units: real("units").notNull(),
    costUsd: real("cost_usd").notNull(),
    /** Kept (as null) when the job is deleted, so the monthly total stays correct. */
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
  },
  (table) => [index("usage_ts_idx").on(table.ts)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** Any JSON value. */
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});
