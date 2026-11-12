# Task list

Work top to bottom. One task per session. Each task is a self-contained prompt: read the listed doc sections, implement, make **Verify** pass, tick the box, commit as `Tnn: …`.

Status note: T12–T19 have partial work in existing branches/commits; unchecked means acceptance is not complete. Preserve code, data and history. T17 and T19 below supersede their original sync scope; legacy sync implementations are not approval to use or delete them. Follow the revised dependency/order notes in `plan.md`.

Legend: **Read** = sections to load · **Accept** = what must be true · **Verify** = how to prove it.

---

## M0 — Foundation

- [x] **T01 Scaffold the monorepo**
  - Read: AGENTS.md; ARCHITECTURE §2; SPEC "Tech stack"
  - Do: pnpm workspace with `packages/shared`, `apps/server`, `apps/web` (empty Vite React app); TypeScript strict; ESLint + Prettier; Vitest; root scripts `dev`, `test`, `lint`, `gen`, `smoke`; pin exact dependency versions (latest stable). Do not create `apps/mobile` yet.
  - Accept: scripts in AGENTS.md "Commands" exist (stubs allowed for `gen`, `smoke`); works from PowerShell and git-bash.
  - Verify: `pnpm install && pnpm lint && pnpm test` exit 0 with one trivial test per workspace.

- [x] **T02 Shared contracts**
  - Read: ARCHITECTURE §4, §6
  - Do: zod schemas and inferred types for `ScriptSegment`, `Token`, `Episode`, topic, job, API request/response bodies, and config (`.env` parsing with defaults for both profiles).
  - Accept: invalid fixtures are rejected with readable messages; `schemaVersion` is checked.
  - Verify: `pnpm --filter shared test` with valid and invalid fixtures for each schema.

- [x] **T03 Database and config**
  - Read: ARCHITECTURE §4 "SQLite tables"
  - Do: Drizzle schema + migrations for all tables; `config.ts` loading `.env` through the shared schema; `data/` directory bootstrap.
  - Verify: test creates a temp DB, runs migrations, round-trips one row per table.

## M1 — Walking skeleton: topic in, audio out (CLI only)

- [x] **T04 Provider interfaces and fakes**
  - Read: ARCHITECTURE §5
  - Do: the four interfaces, deterministic fakes (fake TTS emits a sine WAV whose length is proportional to text length), a `createProviders(config)` factory.
  - Verify: unit tests use only fakes; factory selects by profile.

- [x] **T05 LLM provider (cloud + Ollama)**
  - Read: ARCHITECTURE §5, §3 "Prompt handling", "Cost guard". Check current AI SDK docs for structured output.
  - Do: `generateObject` over AI SDK with `main`/`fast` slots, schema validation, one retry on invalid output, usage recording.
  - Verify: unit tests with a mocked model; `pnpm smoke --only llm` returns a schema-valid object from the configured cloud model and from Ollama.

- [x] **T06 Search providers**
  - Do: Tavily and Brave implementations; SearXNG implementation + `infra/docker-compose.searxng.yml` with JSON output enabled; URL canonicalisation and dedupe helper.
  - Verify: unit tests against recorded JSON fixtures; `pnpm smoke --only search`.

- [x] **T07 Extractor**
  - Read: ARCHITECTURE §5 last bullet
  - Do: fetch with timeout, size cap, private-address refusal, Readability extraction, 8k-char trim on paragraph boundaries.
  - Verify: tests on saved HTML fixtures (article, paywall stub, non-HTML); a test proving `http://127.0.0.1`, `http://169.254.169.254` and `file://` are refused.

- [x] **T08 Stages plan, search, extract, notes**
  - Read: ARCHITECTURE §3 rows 1–4
  - Do: stage functions with artifacts and input hashing; prompts as markdown files; "≥ 3 usable sources" rule.
  - Verify: tests with fakes: artifacts are written, a second run is a no-op, a changed input re-runs only downstream stages.

- [x] **T09 Stage script (standard mode) and review**
  - Read: ARCHITECTURE §3 rows 5–6, §4
  - Do: script prompt for a single-narrator episode with intro, 3–5 chapters, recap, outro; word budget; `sourceIds` on content segments; review stage that removes or fixes ungrounded claims.
  - Verify: tests with a fake LLM; schema-valid output; a test where the fake returns an ungrounded segment and review flags it.

- [x] **T10 TTS providers: Azure and OpenAI**
  - Read: ARCHITECTURE §5 table and notes. Check current provider docs for voices, rate control, output formats, pricing.
  - Do: implementations, WAV normalisation, content-hash cache, concurrency limit, backoff, `voices(lang)`.
  - Verify: unit tests with mocked HTTP; cache hit avoids a second call; `pnpm smoke --only tts` writes one English and one Hungarian WAV.

- [x] **T11 Audio assembly with exact timings**
  - Read: ARCHITECTURE §3 rows 7–8
  - Do: PCM concat with silences, sample-count timings, loudness normalisation, AAC encode, chapters.
  - Accept: SC2.
  - Verify: test builds an episode from fake-TTS WAVs of known lengths and asserts every `startMs`/`endMs` within ±80 ms of ffprobe-measured positions (detect segment starts in the output using distinct sine frequencies per segment).

- [ ] **T12 Job runner and `pnpm gen`**
  - Read: ARCHITECTURE §3 (intro, row 9, cost guard)
  - Do: runner that executes stages in order with DB status, resume, retry-from-stage, cancel, budget refusal; `publish` stage; CLI `pnpm gen "<topic>" --minutes 8 --lang en --mode standard`.
  - Accept: SC1, SC4.
  - Verify: fake-provider test that kills the run after stage 5 and resumes without re-calling the LLM; then a real run of `pnpm gen` and listen to the result. **Owner checkpoint: is the episode good enough to continue?**

## M2 — Server API and desktop UI

- [ ] **T13 HTTP API**
  - Read: ARCHITECTURE §6, §9
  - Do: all routes except pairing/sync/feed; SSE; Range support for audio; loopback-only default.
  - Verify: Fastify inject tests for each route including a Range request; SSE test receives stage events for a fake job.

- [ ] **T14 Scheduler and recurring topics**
  - Read: ARCHITECTURE §3 rows 1–2
  - Do: cron per topic, missed-run catch-up on start (one run at most), `used_sources` exclusion, previous-episode summaries in the plan prompt.
  - Accept: SC3.
  - Verify: fake-clock test: two scheduled runs produce two episodes with disjoint source URLs.

- [ ] **T15 Web UI: generate, jobs, library, player**
  - Read: ARCHITECTURE §8
  - Do: pages New episode, Jobs (live progress, retry), Library, Player with synced transcript and sources list. Typed API client from shared schemas.
  - Verify: component tests for transcript highlighting given a position; manual check listed in the task report: create an episode from the browser and play it.

- [ ] **T16 Web UI: topics, settings, install, autostart**
  - Do: Topics CRUD with schedule; Settings (profile, voices with preview, native language, budget, usage totals); web manifest; `autostart:install` / `autostart:remove` scripts using Windows Task Scheduler.
  - Verify: manual: install from Edge as an app; reboot-free check with `schtasks /Run`; settings response contains no secret values (automated test).

## M3 — Android app core

- [ ] **T17 Local transfer security design and device acceptance**
  - History: pairing/auth and playback/vocabulary sync endpoint foundations exist; safe phone pairing remains unavailable. Preserve them, but do not use sync endpoints for phone progress.
  - Read: ARCHITECTURE §6–§9; SPEC transfer requirements; AGENTS.md boundaries.
  - Do: design and obtain review for LAN-only discovery, explicit PC-side acceptance of each device, trusted encrypted transport and server identity, scoped episode-read authorization, expiry/revocation, and no public exposure. Keep loopback default; ask first for a different default or contract/schema/package changes. Implement only after necessary approvals.
  - Accept/Verify: automated rejection tests for unauthorized/revoked devices and non-LAN access; verify no plaintext credentials, no broader API exposure, and no automatic progress transfer; device test explicit accept/reject and secure download.

- [ ] **T18 Mobile scaffold and background player**
  - Read: ARCHITECTURE §7; docs/SETUP.md "Phone". Read current expo-audio docs first.
  - Do: `apps/mobile` with Expo SDK 58, expo-router, expo-dev-client; a Player screen that plays a bundled sample episode package with background playback, lock-screen controls, seek, speed.
  - Verify: `pnpm --filter mobile android` installs on the USB phone. Device checklist: plays 10 minutes with screen off; lock-screen pause/resume works; survives switching apps; position restored after force-stop.

- [ ] **T19 One-way Wi-Fi downloads and USB package import**
  - History: sample library, local playback checkpoints, package staging and integrity verification foundations exist; full transfer and device verification remain open.
  - Depends: T17 approved secure transport for Wi-Fi; USB import can be developed independently, after T18 foundations.
  - Do: download finished episodes only on home Wi-Fi after explicit PC device acceptance; separately allow manual USB package copy and phone selection/import. Validate existing shared schema, safe paths, audio size and SHA-256; stage and atomically publish, preserving library and local progress on failures. Resolve duplicate behavior in design. Do not upload progress. Ask first for package or schema changes.
  - Accept: SC5.
  - Verify: tests for malformed, missing, corrupted, unsafe and duplicate packages, interrupted download/import and no progress upload; device checks for both Wi-Fi and USB paths, then airplane-mode playback and restart position.

## M4 — Hungarian learning

- [ ] **T20 Graded Hungarian script mode**
  - Read: LEARNING-MODE §1 (graded), §2, §5, §6
  - Do: graded script prompt per level, annotation call (translation, tokens, morphemes), proofreading and level review, structural validators with one auto-regeneration.
  - Verify: validator unit tests (token reconstruction, target-word frequency, sentence length); `pnpm gen "…" --lang hu --mode graded --level A1 --minutes 5`; **owner checkpoint: have a Hungarian speaker or a second model spot-check 20 sentences.**

- [ ] **T21 Bilingual teacher mode**
  - Read: LEARNING-MODE §1 (bilingual), §6
  - Do: four-segment pattern, two voices, `repeatOf`, pauses.
  - Verify: test asserts the pattern and language alternation on fake output; one real episode listened to.

- [ ] **T22 Mobile transcript, translation, word sheet**
  - Read: LEARNING-MODE §3 rows 1–3
  - Accept: SC6.
  - Verify: jest tests for the position → segment lookup and token rendering; device check in airplane mode.

- [ ] **T23 Sentence drill, speed, A–B loop**
  - Read: LEARNING-MODE §3 rows 4–6
  - Accept: SC7.
  - Verify: jest tests for the drill state machine with a fake player clock; device check that auto-pause lands within the inter-sentence silence.

- [ ] **T24 Vocabulary and FSRS review**
  - Read: LEARNING-MODE §3 rows 7–9
  - Do: save word, local cards, review screen with sentence-audio replay and daily limits; do not sync to server.
  - Accept: SC8.
  - Verify: jest tests for scheduling transitions with `ts-fsrs` and a fixed clock; device check state survives app restart offline and no automatic upload occurs. Reinstall recovery is not promised.

## M5 — Adaptive loop, local profile, polish

- [ ] **T25 Vocabulary-aware generation — deferred**
  - History: original goal was automatic reuse of phone due words (SC9). This is incompatible with phone-local progress; do not implement automatic synchronization.
  - Read: LEARNING-MODE §4. Ask the owner before designing any separate manual PC input or backup; no schema or package changes without approval.
  - Accept/Verify: only define after the owner chooses a permitted approach; no automatic phone-to-PC transfer.

- [ ] **T26 Local profile: Ollama, Piper, SearXNG**
  - Read: ARCHITECTURE §5 table and notes; docs/SETUP.md "Local profile"
  - Do: Piper provider (download script for one `en_US` and one `hu_HU` voice), profile switch in Settings, refusal of learning modes on local unless overridden.
  - Accept: SC10.
  - Verify: smoke test with a network guard that allows only loopback and fetched article hosts.

- [ ] **T27 Optional extras (ask the owner which)**
  - ElevenLabs TTS provider · RSS feed `/feed.xml` · Electron tray shell · two-host English mode · release APK signing script · backup/restore of `data/`.
