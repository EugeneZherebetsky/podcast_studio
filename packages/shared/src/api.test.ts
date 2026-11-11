import { describe, expect, test } from "vitest";
import {
  ApiErrorSchema,
  CreateJobRequestSchema,
  CreateTopicRequestSchema,
  EpisodeSummarySchema,
  FeedQuerySchema,
  GetEpisodeResponseSchema,
  HealthResponseSchema,
  IdParamsSchema,
  JobDetailSchema,
  JobSchema,
  JobStageSchema,
  JobStageStatusSchema,
  JobStatusSchema,
  ListEpisodesQuerySchema,
  ListEpisodesResponseSchema,
  ListJobsResponseSchema,
  ListTopicsResponseSchema,
  OkResponseSchema,
  PairCompleteRequestSchema,
  PairCompleteResponseSchema,
  PairStartResponseSchema,
  RetryJobRequestSchema,
  ServerEventSchema,
  SettingsSchema,
  StageNameSchema,
  SyncPlaybackRequestSchema,
  SyncVocabRequestSchema,
  SyncVocabResponseSchema,
  TopicSchema,
  UpdateSettingsRequestSchema,
  UpdateTopicRequestSchema,
} from "./index.ts";
import {
  validEpisode,
  validEpisodeSummary,
  validJob,
  validJobOptions,
  validJobStage,
  validPlaybackPosition,
  validSettings,
  validTopic,
  validVocabCard,
} from "./fixtures.ts";
import { expectInvalid, expectValid } from "./testing.ts";

describe("Topic", () => {
  test("accepts a scheduled and an unscheduled topic", () => {
    expectValid(TopicSchema, validTopic);
    expectValid(TopicSchema, { ...validTopic, schedule: null, level: "A2", mode: "graded" });
    expectValid(TopicSchema, { ...validTopic, lastRunAt: "2026-11-10T07:00:00.000Z" });
  });

  test("rejects bad fields", () => {
    expectInvalid(TopicSchema, { ...validTopic, title: "" }, /title/);
    expectInvalid(TopicSchema, { ...validTopic, mode: "chat" }, /mode.*standard/);
    expectInvalid(TopicSchema, { ...validTopic, minutes: 0 }, /minutes/);
    expectInvalid(TopicSchema, { ...validTopic, enabled: "yes" }, /enabled.*boolean/);
    expectInvalid(TopicSchema, { ...validTopic, lastRunAt: "last week" }, /lastRunAt/);
  });
});

describe("job and job stage status", () => {
  test("accept the known values", () => {
    for (const s of ["queued", "running", "succeeded", "failed", "cancelled"]) {
      expectValid(JobStatusSchema, s);
    }
    for (const s of ["pending", "running", "done", "skipped", "failed"]) {
      expectValid(JobStageStatusSchema, s);
    }
    for (const s of [
      "plan",
      "search",
      "extract",
      "notes",
      "script",
      "review",
      "tts",
      "assemble",
      "publish",
    ]) {
      expectValid(StageNameSchema, s);
    }
  });

  test("reject unknown values, listing the options", () => {
    expectInvalid(JobStatusSchema, "exploded", /queued/);
    expectInvalid(JobStageStatusSchema, "queued", /pending/);
    expectInvalid(StageNameSchema, "upload", /plan/);
  });
});

describe("Job and JobStage", () => {
  test("accept valid rows", () => {
    expectValid(JobSchema, validJob);
    expectValid(JobSchema, {
      ...validJob,
      status: "failed",
      error: "extract: only 2 usable sources, need at least 3",
      options: { ...validJobOptions, granularity: "sentence", review: false, level: "A1" },
    });
    expectValid(JobStageSchema, validJobStage);
    expectValid(JobStageSchema, {
      ...validJobStage,
      status: "pending",
      inputHash: null,
      startedAt: null,
      finishedAt: null,
    });
    expectValid(JobDetailSchema, { ...validJob, stages: [validJobStage] });
  });

  test("reject invalid rows", () => {
    expectInvalid(JobSchema, { ...validJob, status: "done" }, /status.*queued/);
    expectInvalid(JobSchema, { ...validJob, currentStage: "upload" }, /currentStage/);
    expectInvalid(
      JobSchema,
      { ...validJob, options: { ...validJobOptions, granularity: "word" } },
      /options\.granularity.*sentence/,
    );
    expectInvalid(JobStageSchema, { ...validJobStage, stage: "upload" }, /stage/);
    expectInvalid(JobStageSchema, { ...validJobStage, status: "ok" }, /status/);
    expectInvalid(JobDetailSchema, validJob, /stages/);
    expectInvalid(
      JobDetailSchema,
      { ...validJob, stages: [{ ...validJobStage, jobId: 4 }] },
      /stages\[0\]\.jobId/,
    );
  });
});

describe("GET /health", () => {
  const valid = {
    version: "0.1.0",
    profile: "cloud",
    providers: {
      llm: { name: "anthropic", reachable: true },
      search: { name: "tavily", reachable: true },
      tts: { name: "azure", reachable: false },
    },
  };
  test("accepts a valid body", () => expectValid(HealthResponseSchema, valid));
  test("rejects invalid bodies", () => {
    expectInvalid(HealthResponseSchema, { ...valid, profile: "hybrid" }, /profile.*cloud.*local/);
    expectInvalid(
      HealthResponseSchema,
      { ...valid, providers: { ...valid.providers, tts: { name: "azure" } } },
      /providers\.tts\.reachable/,
    );
  });
});

describe("/topics routes", () => {
  const create = {
    title: "AI news",
    brief: "Weekly round-up.",
    mode: "standard",
    lang: "en",
    minutes: 10,
  };

  test("GET /topics response", () => {
    expectValid(ListTopicsResponseSchema, { topics: [validTopic] });
    expectValid(ListTopicsResponseSchema, { topics: [] });
    expectInvalid(
      ListTopicsResponseSchema,
      { topics: [{ ...validTopic, id: 1 }] },
      /topics\[0\]\.id/,
    );
    expectInvalid(ListTopicsResponseSchema, [validTopic], /object/);
  });

  test("POST /topics request applies defaults", () => {
    expect(CreateTopicRequestSchema.parse(create)).toEqual({ ...create, enabled: true });
    expectValid(CreateTopicRequestSchema, {
      ...create,
      mode: "graded",
      lang: "hu",
      level: "A1",
      schedule: "0 7 * * *",
      enabled: false,
    });
  });

  test("POST /topics request rejects bad input", () => {
    expectInvalid(CreateTopicRequestSchema, { ...create, title: "  " }, /title/);
    expectInvalid(CreateTopicRequestSchema, { ...create, minutes: "ten" }, /minutes.*number/);
    expectInvalid(CreateTopicRequestSchema, { ...create, minutes: 2.5 }, /minutes/);
    expectInvalid(CreateTopicRequestSchema, { ...create, level: "C1" }, /level/);
    expectInvalid(CreateTopicRequestSchema, {}, /title/, /mode/, /lang/, /minutes/);
  });

  test("PATCH /topics/:id request", () => {
    expectValid(UpdateTopicRequestSchema, { enabled: false });
    expectValid(UpdateTopicRequestSchema, { schedule: null, level: null, minutes: 12 });
    expect(UpdateTopicRequestSchema.parse({ title: "New" })).toEqual({ title: "New" });
    expectInvalid(UpdateTopicRequestSchema, {}, /at least one field/);
    expectInvalid(UpdateTopicRequestSchema, { minutes: -3 }, /minutes/);
    expectInvalid(UpdateTopicRequestSchema, { mode: "chat" }, /mode/);
  });

  test(":id params and the ok response", () => {
    expectValid(IdParamsSchema, { id: "topic-01" });
    expectInvalid(IdParamsSchema, { id: "" }, /id/);
    expectInvalid(IdParamsSchema, {}, /id/);
    expectValid(OkResponseSchema, { ok: true });
    expectInvalid(OkResponseSchema, { ok: false }, /ok/);
  });
});

describe("/jobs routes", () => {
  test("POST /jobs accepts a topic reference or an ad-hoc request", () => {
    expect(CreateJobRequestSchema.parse({ topicId: "topic-01" })).toEqual({ topicId: "topic-01" });
    expectValid(CreateJobRequestSchema, validJobOptions);
    expectValid(CreateJobRequestSchema, {
      title: "A macska",
      brief: "Cats, simply.",
      mode: "graded",
      lang: "hu",
      level: "A1",
      minutes: 5,
    });
  });

  test("POST /jobs explains what is wrong with an ad-hoc request", () => {
    expectInvalid(CreateJobRequestSchema, { ...validJobOptions, minutes: 0 }, /minutes/);
    expectInvalid(CreateJobRequestSchema, { ...validJobOptions, mode: "chat" }, /mode.*standard/);
    expectInvalid(CreateJobRequestSchema, { title: "Cube" }, /mode/, /lang/, /minutes/);
  });

  test("POST /jobs explains what is wrong with a topic reference", () => {
    expectInvalid(CreateJobRequestSchema, { topicId: 12 }, /topicId.*string/);
    expectInvalid(CreateJobRequestSchema, { topicId: "" }, /topicId/);
  });

  test("POST /jobs rejects an empty body and a non-object", () => {
    expectInvalid(CreateJobRequestSchema, {}, /topicId|title/);
    expectInvalid(CreateJobRequestSchema, null, /./);
  });

  test("GET /jobs and GET /jobs/:id responses", () => {
    expectValid(ListJobsResponseSchema, { jobs: [validJob] });
    expectInvalid(ListJobsResponseSchema, { jobs: [{ ...validJob, id: null }] }, /jobs\[0\]\.id/);
    expectValid(JobDetailSchema, { ...validJob, stages: [] });
  });

  test("POST /jobs/:id/retry request", () => {
    expectValid(RetryJobRequestSchema, {});
    expectValid(RetryJobRequestSchema, { fromStage: "script" });
    expectInvalid(RetryJobRequestSchema, { fromStage: "upload" }, /fromStage.*plan/);
  });
});

describe("GET /events payloads", () => {
  test("accepts both event types", () => {
    expectValid(ServerEventSchema, {
      type: "job-stage",
      jobId: "job-01",
      stage: "tts",
      status: "running",
    });
    expectValid(ServerEventSchema, {
      type: "job-stage",
      jobId: "job-01",
      stage: "extract",
      status: "failed",
      error: "only 2 usable sources",
    });
    expectValid(ServerEventSchema, { type: "episode-ready", jobId: "job-01", episodeId: "ep-01" });
  });

  test("rejects unknown and malformed events", () => {
    expectInvalid(ServerEventSchema, { type: "ping" }, /type/);
    expectInvalid(ServerEventSchema, { type: "episode-ready", jobId: "job-01" }, /episodeId/);
    expectInvalid(
      ServerEventSchema,
      { type: "job-stage", jobId: "job-01", stage: "tts", status: "ok" },
      /status/,
    );
  });
});

describe("/episodes routes", () => {
  test("GET /episodes query", () => {
    expectValid(ListEpisodesQuerySchema, {});
    expectValid(ListEpisodesQuerySchema, { since: "2026-11-01T00:00:00.000Z" });
    expectInvalid(ListEpisodesQuerySchema, { since: "last tuesday" }, /since/);
  });

  test("GET /episodes response", () => {
    expectValid(EpisodeSummarySchema, validEpisodeSummary);
    expectValid(ListEpisodesResponseSchema, { episodes: [validEpisodeSummary] });
    expectInvalid(
      ListEpisodesResponseSchema,
      { episodes: [{ ...validEpisodeSummary, durationMs: -5 }] },
      /episodes\[0\]\.durationMs/,
    );
    expectInvalid(EpisodeSummarySchema, { ...validEpisodeSummary, mode: "x" }, /mode/);
  });

  test("GET /episodes/:id response is the full episode.json", () => {
    expectValid(GetEpisodeResponseSchema, validEpisode);
    expectInvalid(
      GetEpisodeResponseSchema,
      { ...validEpisode, schemaVersion: 2 },
      /schemaVersion.*expected 1/,
    );
  });
});

describe("/pair routes", () => {
  test("POST /pair/start response", () => {
    expectValid(PairStartResponseSchema, {
      qr: "podcast-studio://pair?host=192.168.1.5&code=123456",
    });
    expectInvalid(PairStartResponseSchema, {}, /qr/);
  });

  test("POST /pair/complete request and response", () => {
    expectValid(PairCompleteRequestSchema, { code: "123456", deviceName: "Pixel 9" });
    expectInvalid(PairCompleteRequestSchema, { code: "123456" }, /deviceName/);
    expectInvalid(PairCompleteRequestSchema, { code: "", deviceName: "Pixel 9" }, /code/);
    expectValid(PairCompleteResponseSchema, { token: "tok_abc" });
    expectInvalid(PairCompleteResponseSchema, { token: 5 }, /token.*string/);
  });
});

describe("/sync routes", () => {
  test("POST /sync/playback request", () => {
    expectValid(SyncPlaybackRequestSchema, { positions: [validPlaybackPosition] });
    expectValid(SyncPlaybackRequestSchema, { positions: [] });
    expectInvalid(
      SyncPlaybackRequestSchema,
      { positions: [{ ...validPlaybackPosition, positionMs: -1 }] },
      /positions\[0\]\.positionMs/,
    );
    expectInvalid(
      SyncPlaybackRequestSchema,
      { positions: [{ ...validPlaybackPosition, updatedAt: "now" }] },
      /positions\[0\]\.updatedAt/,
    );
    expectInvalid(SyncPlaybackRequestSchema, {}, /positions/);
  });

  test("POST /sync/vocab request and response", () => {
    expectValid(SyncVocabRequestSchema, { cards: [validVocabCard] });
    expectValid(SyncVocabResponseSchema, { cards: [validVocabCard] });
    expectValid(SyncVocabResponseSchema, { cards: [] });
    expectInvalid(
      SyncVocabRequestSchema,
      { cards: [{ ...validVocabCard, state: "mastered" }] },
      /cards\[0\]\.state.*new/,
    );
    expectInvalid(
      SyncVocabRequestSchema,
      { cards: [{ ...validVocabCard, lemma: "" }] },
      /cards\[0\]\.lemma/,
    );
    expectInvalid(
      SyncVocabResponseSchema,
      { cards: [{ ...validVocabCard, card: "raw" }] },
      /cards\[0\]\.card/,
    );
  });
});

describe("/settings routes", () => {
  test("GET /settings response", () => {
    expectValid(SettingsSchema, validSettings);
    expectInvalid(SettingsSchema, { ...validSettings, profile: "hybrid" }, /profile/);
    expectInvalid(SettingsSchema, { ...validSettings, monthlyBudgetUsd: -1 }, /monthlyBudgetUsd/);
    expectInvalid(
      SettingsSchema,
      { ...validSettings, voices: { ...validSettings.voices, huHost: 3 } },
      /voices\.huHost/,
    );
  });

  test("settings never carry secrets: unknown keys are rejected", () => {
    expectInvalid(
      SettingsSchema,
      { ...validSettings, ANTHROPIC_API_KEY: "sk-secret" },
      /ANTHROPIC_API_KEY/,
    );
    expectInvalid(UpdateSettingsRequestSchema, { azureSpeechKey: "secret" }, /azureSpeechKey/);
  });

  test("PUT /settings request is a partial update", () => {
    expectValid(UpdateSettingsRequestSchema, { level: "A2" });
    expectValid(UpdateSettingsRequestSchema, { voices: { nativeHost: "en-US-AvaNeural" } });
    expectValid(UpdateSettingsRequestSchema, { profile: "local", monthlyBudgetUsd: 0 });
    expectInvalid(UpdateSettingsRequestSchema, { level: "C2" }, /level/);
    expectInvalid(UpdateSettingsRequestSchema, { monthlyBudgetUsd: "lots" }, /monthlyBudgetUsd/);
  });
});

describe("feed and errors", () => {
  test("GET /feed.xml query", () => {
    expectValid(FeedQuerySchema, { token: "tok_abc" });
    expectInvalid(FeedQuerySchema, {}, /token/);
  });

  test("error body", () => {
    expectValid(ApiErrorSchema, { error: "Topic not found" });
    expectInvalid(ApiErrorSchema, { message: "nope" }, /error/);
  });
});
