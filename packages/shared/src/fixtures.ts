// Test fixtures shared by the schema tests. Not exported from the package.

export const validToken = {
  surface: "házamban",
  lemma: "ház",
  pos: "noun",
  gloss: "in my house",
  morphemes: [
    { form: "ház", meaning: "house" },
    { form: "-am", meaning: "my" },
    { form: "-ban", meaning: "in" },
  ],
  isTarget: true,
};

export const validScriptSegment = {
  id: "seg-0001",
  kind: "content",
  speaker: "host",
  lang: "hu",
  text: "A házamban lakom.",
  rate: 0.9,
  pauseAfterMs: 400,
  sourceIds: ["s1", "s3"],
  translation: "I live in my house.",
  tokens: [validToken],
};

export const minimalScriptSegment = {
  id: "seg-0002",
  kind: "intro",
  speaker: "host",
  lang: "en",
  text: "Welcome to the show.",
};

export const validEpisodeSegment = { ...validScriptSegment, startMs: 0, endMs: 2150 };

export const validEpisode = {
  schemaVersion: 1,
  id: "ep-01",
  topicId: "topic-01",
  title: "The Rubik's cube",
  summary: "A short history of the cube.",
  createdAt: "2026-11-11T09:30:00.000Z",
  durationMs: 4000,
  mode: "graded",
  lang: "hu",
  nativeLang: "en",
  level: "A1",
  audio: { file: "audio.m4a", bytes: 123456, sha256: "a".repeat(64) },
  segments: [validEpisodeSegment, { ...minimalScriptSegment, startMs: 2550, endMs: 4000 }],
  chapters: [{ title: "Intro", startMs: 0 }],
  sources: [
    {
      id: "s1",
      url: "https://example.com/cube",
      title: "Cube history",
      site: "example.com",
      publishedAt: "2026-10-01",
    },
  ],
  targetVocabulary: [{ lemma: "ház", gloss: "house" }],
  generation: {
    profile: "cloud",
    llm: "some-model",
    tts: "azure",
    voice: "hu-HU-NoemiNeural",
    costUsd: 0.12,
  },
};

export const validTopic = {
  id: "topic-01",
  title: "AI news",
  brief: "Weekly round-up of AI research.",
  mode: "standard",
  lang: "en",
  level: null,
  minutes: 10,
  schedule: "0 7 * * 1",
  enabled: true,
  lastRunAt: null,
};

export const validJobOptions = {
  title: "The Rubik's cube",
  brief: "",
  mode: "standard",
  lang: "en",
  minutes: 8,
};

export const validJobStage = {
  jobId: "job-01",
  stage: "plan",
  status: "done",
  inputHash: "b".repeat(64),
  startedAt: "2026-11-11T09:30:00.000Z",
  finishedAt: "2026-11-11T09:30:05.000Z",
  error: null,
};

export const validJob = {
  id: "job-01",
  topicId: null,
  status: "running",
  currentStage: "search",
  error: null,
  options: validJobOptions,
  createdAt: "2026-11-11T09:30:00.000Z",
  updatedAt: "2026-11-11T09:30:05.000Z",
};

export const validEpisodeSummary = {
  id: "ep-01",
  topicId: null,
  title: "The Rubik's cube",
  summary: "A short history of the cube.",
  mode: "standard",
  lang: "en",
  durationMs: 4000,
  createdAt: "2026-11-11T09:30:00.000Z",
};

export const validPlaybackPosition = {
  episodeId: "ep-01",
  positionMs: 61000,
  finished: false,
  updatedAt: "2026-11-11T10:00:00.000Z",
};

export const validVocabCard = {
  lemma: "ház",
  lang: "hu",
  gloss: "house",
  state: "learning",
  dueAt: "2026-11-12T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
  card: { stability: 2.3, difficulty: 5.1, reps: 2 },
};

export const validSettings = {
  profile: "cloud",
  nativeLang: "en",
  targetLang: "hu",
  level: "A1",
  monthlyBudgetUsd: 20,
  voices: {
    huHost: "hu-HU-NoemiNeural",
    huCohost: "hu-HU-TamasNeural",
    nativeHost: null,
    nativeTeacher: null,
  },
};
