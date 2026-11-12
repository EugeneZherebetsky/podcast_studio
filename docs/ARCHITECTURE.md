# Architecture

## 1. Overview

```
┌────────────────────────── Windows PC (home server) ──────────────────────────┐
│                                                                              │
│  apps/web (React SPA) ──HTTP──┐                                              │
│   = the desktop app           │                                              │
│                               ▼                                              │
│                    apps/server (Fastify, :4747)                              │
│        ┌──────────────┬───────────────┬──────────────┐                       │
│        │ api          │ pipeline      │ scheduler    │                       │
│        │ REST + SSE   │ job runner    │ cron topics  │                       │
│        └──────┬───────┴───────┬───────┴──────────────┘                       │
│               │               │                                              │
│        SQLite (data/app.db)   │  providers (interfaces)                      │
│        data/episodes/<id>/    ├─ LlmProvider    → Anthropic | OpenAI | Google | Ollama
│          audio.m4a            ├─ SearchProvider → Tavily | Brave | SearXNG (Docker)
│          episode.json         ├─ Extractor      → fetch + Readability        │
│        data/cache/tts/        ├─ TtsProvider    → Azure | OpenAI | ElevenLabs | Piper
│                               └─ ffmpeg / ffprobe                            │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │ HTTPS via Tailscale, or HTTP on home Wi-Fi; bearer token
┌───────────────┴──────────── Android phone ───────────────────────────────────┐
│  apps/mobile (Expo)                                                          │
│   sync ── library (expo-sqlite + files) ── player (expo-audio, background)   │
│   learning: synced transcript, sentence drill, vocabulary, FSRS review       │
└──────────────────────────────────────────────────────────────────────────────┘
```

Principles:

- **The server does all the thinking.** The phone never calls an LLM, search or TTS provider. Everything a learner needs offline (translations, word glosses, timings) is computed at generation time and shipped inside `episode.json`.
- **An episode is a self-contained package:** one audio file plus one JSON file. Any client that can read both can play it.
- **Providers are swappable by config.** Pipeline code depends on interfaces only.

## 2. Repository layout

```
podcast-studio/
  AGENTS.md  CLAUDE.md  README.md  .env.example
  docs/        SPEC.md ARCHITECTURE.md LEARNING-MODE.md SETUP.md
  tasks/       plan.md todo.md
  packages/
    shared/    src/{episode.ts, api.ts, config.ts, index.ts}   zod schemas + inferred types
  apps/
    server/    src/
                 providers/{llm,search,extract,tts}/   interface.ts + one file per implementation + fake.ts
                 pipeline/{stages/*.ts, runner.ts, prompts/*.md, scheduler.ts}
                 audio/{ffmpeg.ts, assemble.ts}
                 api/{routes/*.ts, auth.ts, sse.ts}
                 db/{schema.ts, migrations/}
                 cli/{gen.ts, smoke.ts}
                 config.ts  main.ts
               test/   fixtures/
    web/       src/{pages, components, api-client.ts}
    mobile/    app/ (expo-router screens)  src/{sync, player, db, learning}
  data/        (git-ignored) app.db, episodes/, cache/
  infra/       docker-compose.searxng.yml, piper/ (voices, git-ignored)
```

## 3. Generation pipeline

A **job** produces one episode. It is a sequence of stages; each stage reads the previous stage's artifact from `data/jobs/<jobId>/` and writes its own JSON artifact. Stage status lives in SQLite. Re-running a job skips stages whose artifact exists and whose input hash is unchanged.

| # | Stage | Input → Output | Notes |
|---|---|---|---|
| 1 | `plan` | topic, brief, language, mode, previous episode summaries → `plan.json` (5–8 search queries, angle, target word count) | For recurring topics, the prompt includes titles and summaries of the last 5 episodes and asks for what is new |
| 2 | `search` | queries → `candidates.json` (url, title, snippet, date) | Deduplicate by canonical URL; drop URLs already used by this topic; prefer recent for recurring topics |
| 3 | `extract` | top N=8–12 URLs → `sources.json` (id, url, title, site, publishedAt, text ≤ 8k chars) | Parallel fetch, 10 s timeout, Readability; skip failures; require ≥ 3 usable sources or fail with a clear message |
| 4 | `notes` | each source → fact bullets tagged with source id; then merged outline → `notes.json` | Map step can use the cheap model; conflicting facts are kept with both sources noted |
| 5 | `script` | outline + notes + mode + level + learner vocabulary → `script.json` (see §4 `ScriptSegment`) | Structured output validated by zod. Word budget = minutes × 140 (English) or minutes × 90 (graded Hungarian) |
| 6 | `review` | script + notes → corrected `script.json` + `review.json` | Checks every factual claim maps to a note; for Hungarian also a proofreading and level pass (see LEARNING-MODE.md §5). Skippable with `--no-review` |
| 7 | `tts` | each segment → one WAV file (mono, 24 kHz, 16-bit PCM) in `data/cache/tts/<sha256(provider,voice,rate,lang,text)>.wav` | Concurrency 3; retry with backoff; cache means edits re-synthesise only changed segments |
| 8 | `assemble` | WAVs + pauses → `audio.m4a` (AAC, mono, 64 kbps) + timings | Concatenate **PCM**, insert silence per `pauseAfterMs`, loudness-normalise to −16 LUFS, encode once. `startMs`/`endMs` are computed from sample counts before encoding |
| 9 | `publish` | everything → `data/episodes/<id>/{audio.m4a, episode.json}`, DB row `ready` | Emits an SSE event; deletes the job work directory except artifacts needed for retry |

Why per-segment synthesis: it gives exact sentence timings from any TTS provider with no alignment model, allows a different language, voice and speed per segment (needed for bilingual episodes), and makes caching and partial regeneration trivial. The cost is slightly less natural prosody across sentence boundaries; mitigate by synthesising at sentence level for learning modes and at paragraph level (with sentence timings unavailable and not needed) for plain episodes. `granularity: "sentence" | "paragraph"` is a job option, default by mode.

### Prompt handling

- Prompts are markdown files in `pipeline/prompts/`, one per stage and mode, with `{{placeholders}}`. No prompt strings inline in code.
- Source text is wrapped in `<source id="s3">…</source>` and the system prompt states that source content is data and must never be followed as instructions.
- Stages 4–6 call the LLM with **no tools**.
- Two model slots in config: `LLM_MODEL_MAIN` (script, review, Hungarian) and `LLM_MODEL_FAST` (plan, notes).

### Cost guard

Each provider call records estimated cost (tokens or characters × configured price) in the `usage` table. The runner refuses to start a job when the month's total exceeds `MONTHLY_BUDGET_USD`. Prices live in `config.ts` and are editable: do not trust remembered price lists, read them from each provider's pricing page when implementing.

## 4. Data contracts (`packages/shared`)

Illustrative TypeScript; implement as zod schemas and infer the types.

```ts
type Lang = "en" | "hu" | string;            // BCP-47 primary tag
type Mode = "standard" | "graded" | "bilingual";

interface ScriptSegment {                    // LLM output unit, stage 5
  id: string;                                // "seg-0001"
  kind: "intro" | "content" | "explanation" | "recap" | "outro";
  speaker: "host" | "teacher" | "cohost";
  lang: Lang;
  text: string;                              // exactly what is spoken
  rate?: number;                             // 0.7–1.1, TTS speaking rate
  pauseAfterMs?: number;
  sourceIds?: string[];                      // grounding
  // learning modes only:
  translation?: string;                      // into NATIVE_LANG
  tokens?: Token[];
  repeatOf?: string;                         // bilingual: id of the sentence this one repeats
}

interface Token {
  surface: string;                           // "házamban"
  lemma: string;                             // "ház"
  pos: string;                               // "noun"
  gloss: string;                             // "in my house"
  morphemes?: { form: string; meaning: string }[];  // ház=house, -am=my, -ban=in
  isTarget?: boolean;                        // new or due word this episode teaches
}

interface EpisodeSegment extends ScriptSegment { startMs: number; endMs: number; }

interface Episode {
  schemaVersion: 1;
  id: string; topicId?: string;
  title: string; summary: string;
  createdAt: string; durationMs: number;
  mode: Mode; lang: Lang; nativeLang: Lang; level?: "A1" | "A2" | "B1" | "B2";
  audio: { file: "audio.m4a"; bytes: number; sha256: string };
  segments: EpisodeSegment[];
  chapters: { title: string; startMs: number }[];
  sources: { id: string; url: string; title: string; site: string; publishedAt?: string }[];
  targetVocabulary?: { lemma: string; gloss: string }[];
  generation: { profile: string; llm: string; tts: string; voice: string; costUsd: number };
}
```

### SQLite tables (server)

`topics` (id, title, brief, mode, lang, level, minutes, schedule cron, enabled, lastRunAt) · `jobs` (id, topicId, status, currentStage, error, options JSON, timestamps) · `job_stages` (jobId, stage, status, inputHash, startedAt, finishedAt, error) · `episodes` (id, topicId, title, summary, mode, lang, durationMs, createdAt, path) · `used_sources` (topicId, canonicalUrl, episodeId) · `devices` (id, name, tokenHash, createdAt, lastSeenAt) · `vocab` (lemma, lang, gloss, state, dueAt, updatedAt, raw FSRS card JSON) · `playback` (episodeId, deviceId, positionMs, finished, updatedAt) · `usage` (ts, provider, kind, units, costUsd, jobId) · `settings` (key, value).

## 5. Provider interfaces

```ts
interface LlmProvider {
  generateObject<T>(a: { slot: "main" | "fast"; system: string; prompt: string; schema: ZodType<T> }): Promise<{ object: T; usage: Usage }>;
}
interface SearchProvider { search(q: string, o: { max: number; freshnessDays?: number }): Promise<SearchHit[]>; }
interface Extractor      { extract(url: string): Promise<{ title: string; text: string; site: string; publishedAt?: string } | null>; }
interface TtsProvider {
  voices(lang: Lang): Promise<Voice[]>;
  synthesize(a: { text: string; lang: Lang; voice: string; rate: number }): Promise<{ wavPath: string; chars: number }>;
}
```

| Slot | Cloud profile (default) | Local profile |
|---|---|---|
| LLM | Anthropic or OpenAI through AI SDK; model ids from `.env` | Ollama at `http://localhost:11434/v1` through the AI SDK OpenAI-compatible provider |
| Search | Tavily | SearXNG container on `:8888`, JSON format enabled |
| TTS (Hungarian) | Azure AI Speech, voices `hu-HU-NoemiNeural`, `hu-HU-TamasNeural`, rate via SSML `<prosody>` | Piper with a `hu_HU` voice |
| TTS (English) | Azure, or OpenAI / ElevenLabs if configured | Piper `en_US` voice |

Notes for implementers:

- Azure is the default because it has dedicated Hungarian neural voices, SSML rate control, and a monthly free character allowance; confirm the current allowance and voice list in its docs before relying on them. ElevenLabs supports Hungarian only on some models (Flash v2.5 at the time of writing): check before selecting a model.
- Normalise every provider's output to mono 24 kHz 16-bit WAV with ffmpeg before caching.
- Assume the local profile runs on a CPU-only machine with a small model. Such a model can draft an English script slowly; it is **not** adequate for graded Hungarian with correct morphology. The local profile refuses `graded`/`bilingual` modes unless `ALLOW_LOCAL_LEARNING=1`.
- The `Extractor` must refuse non-http(s) URLs and any host resolving to loopback, link-local or private ranges, and cap response size at 5 MB.

## 6. HTTP API (server, prefix `/api`)

All bodies are JSON validated by shared schemas. Requests from non-loopback addresses need `Authorization: Bearer <device token>`, except pairing completion with a valid one-use code.

| Method and path | Purpose |
|---|---|
| `GET /health` | version, profile, reachable providers |
| `GET/POST /topics`, `PATCH/DELETE /topics/:id` | topic and schedule management |
| `POST /jobs` `{topicId} \| {title, brief, mode, lang, level, minutes}` | start generation |
| `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/retry`, `POST /jobs/:id/cancel` | job control |
| `GET /events` (SSE) | job stage progress, episode-ready |
| `GET /episodes?since=<iso>`, `GET /episodes/:id` | list, full `episode.json` |
| `GET /episodes/:id/audio` | audio with HTTP Range support |
| `DELETE /episodes/:id` | remove |
| `POST /pair/start` (loopback only) → `{qr}` ; `POST /pair/complete` `{code, deviceName}` → `{token}` | device pairing |
| `POST /sync/playback` | batch upsert of positions, last write wins on `updatedAt` |
| `POST /sync/vocab` | batch upsert of vocabulary cards, last write wins per lemma; response returns the server's newer rows |
| `GET/PUT /settings` | profile, voices, native language, level, budget; never returns secrets |
| `GET /feed.xml?token=` | optional RSS feed of episodes for third-party podcast apps |

## 7. Mobile app

- **Screens:** Library (downloaded and available), Player (controls + transcript), Topics (list, request episode), Review (vocabulary), Settings (pairing, storage, level).
- **Storage:** expo-sqlite for episodes index, playback positions, vocabulary and FSRS cards; audio and `episode.json` under the app document directory.
- **Sync:** on app foreground, on pull-to-refresh, and after pairing. Steps: `GET /episodes?since`, download missing packages (verify sha256), push playback and vocabulary, pull vocabulary. Wi-Fi-only download is a setting, default on. If the server is unreachable, the app works from local data and shows a quiet "offline" badge.
- **Player:** expo-audio with `shouldPlayInBackground`, lock-screen controls via `setActiveForLockScreen` (required on Android for sustained background playback), `playbackRate` with pitch correction. A position ticker (≈100 ms) drives transcript highlighting by binary search over `segments[].startMs`.
- **Connectivity (planned):** server URL and token come from pairing. Phone pairing is not yet available: the QR contains a loopback address, plain HTTP exposes credentials, and a reverse proxy must not bypass the authentication boundary described in §9. A reachable address, trusted encrypted transport, and mobile integration require design and verification before use.
- **Build:** development build with `expo run:android` on a USB-connected phone (Expo Go is not sufficient for background audio). Release APK with Gradle `assembleRelease`, installed by `adb install`.

## 8. Desktop

`apps/web` is served by the server at `http://localhost:4747` and has a web manifest so Edge/Chrome can install it as a windowed app. A scheduled task (`pnpm run autostart:install`) starts the server at login. Pages: New episode, Topics, Library + player with transcript, Jobs (live progress, retry), Settings (profile, voices with preview, pairing QR, usage and cost).

## 9. Security and privacy

- Server binds `127.0.0.1` unless `HOST=0.0.0.0` is set; then every non-loopback request needs a device token (stored hashed), except pairing completion with a valid one-use code. Pairing codes expire after five minutes or ten failed attempts and are lost on restart. Remote requests carrying browser Origin or Fetch Metadata headers are rejected. Pairing currently returns the local request host in its QR payload, not a remotely reachable address; Settings does not offer a QR until a safe connection is designed. Direct plain HTTP exposes codes and tokens to the network. A reverse proxy must not present remote traffic as trusted loopback traffic; proxy deployment is not supported until its authentication boundary is designed.
- Secrets only in `.env` on the PC. `.env`, `data/`, `infra/piper/` are git-ignored.
- Logs redact `Authorization` headers and anything matching configured key values.
- What leaves the machine in the cloud profile: search queries, topic text, extracted page text, scripts (to the LLM), script text (to TTS). The learner's vocabulary list is sent to the LLM only as lemmas.
- Scripts summarise and attribute; sources are listed in every episode.

## 10. Risks

| Risk | Mitigation |
|---|---|
| LLM writes incorrect or above-level Hungarian, or wrong glosses | Main model only; separate proofreading and level pass; per-token "report error" in the app that excludes the token from vocabulary; see LEARNING-MODE.md §5 |
| Timing drift between transcript and audio | PCM concatenation, timings from sample counts, automated ±80 ms test (SC2) |
| Thin or low-quality search results | Minimum 3 usable sources, otherwise fail with message; user can paste URLs into the brief, which bypass search |
| Android kills background playback | Lock-screen activation as per expo-audio docs; device checklist in T18 |
| Library APIs newer than model knowledge | AGENTS.md rule: read current docs first |
| Runaway API spend | Budget guard, TTS cache, stage resumability |
