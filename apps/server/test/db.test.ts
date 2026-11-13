import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  EpisodeSummarySchema,
  JobSchema,
  JobStageSchema,
  PlaybackPositionSchema,
  TopicSchema,
  VocabCardSchema,
} from "shared";
import { openDatabase, type Db } from "../src/db/index.ts";
import * as t from "../src/db/schema.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

const NOW = "2026-11-11T09:30:00.000Z";
const LATER = "2026-11-11T09:30:05.000Z";

const topic = {
  id: "topic-01",
  title: "AI news",
  brief: "Weekly round-up of AI research.",
  mode: "graded",
  lang: "hu",
  level: "A1",
  minutes: 10,
  schedule: "0 7 * * 1",
  enabled: true,
  lastRunAt: null,
} as const;

const job = {
  id: "job-01",
  topicId: "topic-01",
  status: "running",
  currentStage: "search",
  error: null,
  options: { title: "AI news", brief: "", mode: "graded", lang: "hu", level: "A1", minutes: 10 },
  createdAt: NOW,
  updatedAt: LATER,
} as const;

const jobStage = {
  jobId: "job-01",
  stage: "plan",
  status: "done",
  inputHash: "b".repeat(64),
  startedAt: NOW,
  finishedAt: LATER,
  error: null,
} as const;

const episode = {
  id: "ep-01",
  topicId: "topic-01",
  title: "The Rubik's cube",
  summary: "A short history of the cube.",
  mode: "graded",
  lang: "hu",
  durationMs: 4000,
  createdAt: NOW,
  path: "episodes/ep-01",
} as const;

const device = {
  id: "dev-01",
  name: "Pixel 9",
  tokenHash: "c".repeat(64),
  createdAt: NOW,
  lastSeenAt: null,
};

const vocabCard = {
  lemma: "ház",
  lang: "hu",
  gloss: "house",
  state: "learning",
  dueAt: "2026-11-12T10:00:00.000Z",
  updatedAt: NOW,
  card: { stability: 2.3, difficulty: 5.1, reps: 2 },
} as const;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = makeTempDir();
  db = openDatabase(path.join(dir, "app.db"));
});

afterEach(() => {
  if (db.$client.open) db.$client.close();
  removeTempDir(dir);
});

function seedParents(): void {
  db.insert(t.topics).values(topic).run();
  db.insert(t.jobs).values(job).run();
  db.insert(t.episodes).values(episode).run();
  db.insert(t.devices).values(device).run();
}

describe("openDatabase", () => {
  test("creates the file, applies the migrations and creates every table", () => {
    expect(existsSync(path.join(dir, "app.db"))).toBe(true);
    const names = db.$client
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like '\\_\\_%' escape '\\' and name not like 'sqlite\\_%' escape '\\'",
      )
      .pluck()
      .all();
    expect([...names].sort()).toEqual([
      "devices",
      "episodes",
      "job_stages",
      "jobs",
      "playback",
      "settings",
      "topics",
      "usage",
      "used_sources",
      "vocab",
    ]);
  });

  test("migration adds an empty owner to existing jobs without changing stages", () => {
    const file = path.join(dir, "old.db");
    const old = new Database(file);
    old.exec(readFileSync(new URL("../src/db/migrations/0000_init.sql", import.meta.url), "utf8"));
    old.exec(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    old
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run("old", 1794434452572);
    old
      .prepare(
        "INSERT INTO jobs (id, status, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("existing", "running", JSON.stringify(job.options), NOW, LATER);
    old
      .prepare("INSERT INTO job_stages (job_id, stage, status) VALUES (?, ?, ?)")
      .run("existing", "plan", "running");
    old.close();
    const migrated = openDatabase(file);
    try {
      expect(migrated.select().from(t.jobs).get()).toMatchObject({
        id: "existing",
        status: "running",
        ownerToken: null,
        options: job.options,
      });
      expect(migrated.select().from(t.jobStages).get()).toMatchObject({
        jobId: "existing",
        stage: "plan",
        status: "running",
      });
    } finally {
      migrated.$client.close();
    }
  });

  test("enables WAL mode and foreign keys", () => {
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  test("reopening an existing database re-runs the migrations harmlessly and keeps the data", () => {
    db.insert(t.topics).values(topic).run();
    db.$client.close();
    db = openDatabase(path.join(dir, "app.db"));
    expect(db.select().from(t.topics).all()).toEqual([topic]);
  });

  test("rejects a row that points at a missing parent", () => {
    expect(() => db.insert(t.jobStages).values(jobStage).run()).toThrowError(/FOREIGN KEY/);
  });
});

describe("round trip, one row per table", () => {
  test("topics", () => {
    db.insert(t.topics).values(topic).run();
    const rows = db.select().from(t.topics).all();
    expect(rows).toEqual([topic]);
    expect(TopicSchema.parse(rows[0])).toEqual(topic);
  });

  test("topics: defaults and nullable columns", () => {
    db.insert(t.topics)
      .values({ id: "topic-02", title: "Cats", mode: "standard", lang: "en", minutes: 5 })
      .run();
    expect(db.select().from(t.topics).all()).toEqual([
      {
        id: "topic-02",
        title: "Cats",
        brief: "",
        mode: "standard",
        lang: "en",
        level: null,
        minutes: 5,
        schedule: null,
        enabled: true,
        lastRunAt: null,
      },
    ]);
  });

  test("jobs, including the options JSON", () => {
    db.insert(t.topics).values(topic).run();
    db.insert(t.jobs).values(job).run();
    const rows = db.select().from(t.jobs).all();
    expect(rows).toEqual([{ ...job, ownerToken: null }]);
    expect(JobSchema.parse(rows[0])).toEqual(job);
  });

  test("jobs: an ad-hoc job has no topic", () => {
    const adHoc = { ...job, id: "job-02", topicId: null, currentStage: null };
    db.insert(t.jobs).values(adHoc).run();
    expect(db.select().from(t.jobs).all()).toEqual([{ ...adHoc, ownerToken: null }]);
  });

  test("job_stages", () => {
    seedParents();
    db.insert(t.jobStages).values(jobStage).run();
    const rows = db.select().from(t.jobStages).all();
    expect(rows).toEqual([jobStage]);
    expect(JobStageSchema.parse(rows[0])).toEqual(jobStage);
    expect(() => db.insert(t.jobStages).values(jobStage).run()).toThrowError(/UNIQUE|PRIMARY/);
  });

  test("episodes", () => {
    db.insert(t.topics).values(topic).run();
    db.insert(t.episodes).values(episode).run();
    const rows = db.select().from(t.episodes).all();
    expect(rows).toEqual([episode]);
    const { path: episodePath, ...summary } = episode;
    expect(episodePath).toBe("episodes/ep-01");
    expect(EpisodeSummarySchema.parse(rows[0])).toEqual(summary);
  });

  test("used_sources", () => {
    seedParents();
    const row = {
      topicId: "topic-01",
      canonicalUrl: "https://example.com/cube",
      episodeId: "ep-01",
    };
    db.insert(t.usedSources).values(row).run();
    expect(db.select().from(t.usedSources).all()).toEqual([row]);
    expect(() => db.insert(t.usedSources).values(row).run()).toThrowError(/UNIQUE|PRIMARY/);
  });

  test("devices", () => {
    db.insert(t.devices).values(device).run();
    expect(db.select().from(t.devices).all()).toEqual([device]);
  });

  test("vocab, including the raw FSRS card JSON", () => {
    db.insert(t.vocab).values(vocabCard).run();
    const rows = db.select().from(t.vocab).all();
    expect(rows).toEqual([vocabCard]);
    expect(VocabCardSchema.parse(rows[0])).toEqual(vocabCard);
  });

  test("playback", () => {
    seedParents();
    const position = { episodeId: "ep-01", positionMs: 61000, finished: false, updatedAt: NOW };
    db.insert(t.playback)
      .values({ ...position, deviceId: "dev-01" })
      .run();
    const rows = db.select().from(t.playback).all();
    expect(rows).toEqual([{ ...position, deviceId: "dev-01" }]);
    expect(PlaybackPositionSchema.parse(rows[0])).toEqual(position);
  });

  test("usage", () => {
    seedParents();
    const row = {
      ts: NOW,
      provider: "azure",
      kind: "tts",
      units: 1234,
      costUsd: 0.0197,
      jobId: "job-01",
    };
    db.insert(t.usage).values(row).run();
    db.insert(t.usage)
      .values({ ...row, jobId: null })
      .run();
    expect(db.select().from(t.usage).all()).toEqual([
      { id: 1, ...row },
      { id: 2, ...row, jobId: null },
    ]);
  });

  test("settings store any JSON value under a key", () => {
    db.insert(t.settings)
      .values([
        { key: "level", value: "A2" },
        { key: "monthlyBudgetUsd", value: 20 },
        { key: "voices", value: { huHost: "hu-HU-NoemiNeural", nativeHost: null } },
      ])
      .run();
    expect(db.select().from(t.settings).all()).toEqual([
      { key: "level", value: "A2" },
      { key: "monthlyBudgetUsd", value: 20 },
      { key: "voices", value: { huHost: "hu-HU-NoemiNeural", nativeHost: null } },
    ]);
  });
});

describe("deleting parents", () => {
  test("deleting a job removes its stages and keeps its usage rows", () => {
    seedParents();
    db.insert(t.jobStages).values(jobStage).run();
    db.insert(t.usage)
      .values({
        ts: NOW,
        provider: "tavily",
        kind: "search",
        units: 1,
        costUsd: 0.008,
        jobId: "job-01",
      })
      .run();
    db.delete(t.jobs).run();
    expect(db.select().from(t.jobStages).all()).toEqual([]);
    expect(db.select().from(t.usage).all()).toMatchObject([{ jobId: null, costUsd: 0.008 }]);
  });

  test("deleting a topic keeps its jobs and episodes", () => {
    seedParents();
    db.delete(t.topics).run();
    expect(db.select().from(t.jobs).all()).toMatchObject([{ id: "job-01", topicId: null }]);
    expect(db.select().from(t.episodes).all()).toMatchObject([{ id: "ep-01", topicId: null }]);
  });

  test("deleting an episode or a device removes its playback rows", () => {
    seedParents();
    const row = {
      episodeId: "ep-01",
      deviceId: "dev-01",
      positionMs: 5,
      finished: true,
      updatedAt: NOW,
    };
    db.insert(t.playback).values(row).run();
    db.delete(t.devices).run();
    expect(db.select().from(t.playback).all()).toEqual([]);
    db.insert(t.devices).values(device).run();
    db.insert(t.playback).values(row).run();
    db.delete(t.episodes).run();
    expect(db.select().from(t.playback).all()).toEqual([]);
  });
});
