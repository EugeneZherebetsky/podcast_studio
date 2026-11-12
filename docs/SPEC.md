# Spec: Podcast Studio

## Objective

A single user wants to **listen instead of read**. They name a topic; the system researches it on the internet, writes a podcast script, converts it to speech and has the episode ready to play on the desktop and on an Android phone. The phone app also uses these podcasts to **teach Hungarian** to a beginner (A1–A2).

### User stories

1. *One-off:* "I type a topic and an optional brief, pick length and language, and get an episode in my library a few minutes later."
2. *Recurring:* "I subscribe to a topic with a schedule (daily / weekdays / weekly). A fresh episode covering only what is new is waiting for me each time."
3. *Trust:* "Every episode lists the sources it used. I can read the script."
4. *Phone:* "I accept my phone on the PC, then download finished episodes over home Wi-Fi or manually copy and import an episode package over USB. I listen offline, in the background, with lock-screen controls."
5. *Hungarian – graded:* "I get the episode in simple Hungarian at my level. The transcript follows the audio; I tap a sentence for its translation and a word for its meaning and how it is built."
6. *Hungarian – teacher:* "I get a bilingual episode: Hungarian sentence, then an explanation in my language, then the sentence again."
7. *Hungarian – drill:* "I slow playback down, loop one sentence, auto-pause after each sentence."
8. *Hungarian – vocabulary:* "I save words while listening and review them with spaced repetition. My review progress stays on my phone."
9. *Choice of models:* "By default it uses cloud APIs. I can switch a profile to local models (Ollama, Piper, SearXNG) and accept lower quality."

## Confirmed decisions

| Decision | Choice |
|---|---|
| Phone | Android only |
| Where generation runs | This Windows PC acts as home server; phone receives finished episodes one-way |
| Models | Cloud APIs by default; local models as an optional profile |
| Hungarian level | Beginner, A1–A2 |
| Learning features | Graded Hungarian with synced transcript and translation; bilingual teacher format; vocabulary with spaced repetition; slow playback and sentence repeat |
| Users | One. No accounts, no multi-tenancy |

## Assumptions (correct these if wrong)

1. Explanations and translations are in **English** (`NATIVE_LANG=en`, configurable).
2. "Desktop application" = the server plus a web UI at `http://localhost:4747`, installable as a windowed app from Edge/Chrome and started at login. A native Electron shell is a later, optional task (T27).
3. Typical episode: 5–15 minutes. Longer is allowed but not optimised.
4. Phone receives episodes on home Wi-Fi or by manual USB package copy/import. No remote access, cloud sync, or public internet exposure.
5. Personal use only: no publishing, no app store release. The APK is installed over USB.

### Transfer and privacy requirements

Wi-Fi transfer is PC-to-phone only, restricted to the home LAN, explicitly enabled and authorized by the user on the PC for each device, and uses authenticated private encrypted transport. Loopback remains the server default; any non-loopback default requires prior approval under AGENTS.md. Do not expose the service publicly. The exact discovery, pairing, encryption and revocation design needs review before implementation. A bare checksum detects corruption, not a malicious replacement: authenticate the transport and metadata as well.

USB transfer is an explicit user-driven copy and phone import of the existing episode package (audio and episode JSON). Validate the existing shared schema, safe paths, audio size and SHA-256 before atomically making an import playable; reject incomplete, corrupted or unsupported packages without damaging existing episodes or local progress. USB copy does not authenticate its source; the user must trust and select the copied package. No cloud or internet is required for playback or learning from a downloaded package. PC generation may still use configured internet/cloud providers.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language and one set of shared types for server, web and mobile |
| Repo | pnpm workspaces monorepo | Already installed; shared package for contracts |
| Server | Node 22, Fastify 5, SQLite via better-sqlite3 + Drizzle | No external database to run; one file to back up |
| LLM access | Vercel AI SDK 7 (`ai` + provider packages) | One interface for Anthropic, OpenAI, Google and Ollama (OpenAI-compatible endpoint) |
| Web search | Tavily (default), Brave Search, SearXNG in Docker (local profile) | Behind one `SearchProvider` interface |
| Page extraction | `fetch` + `@mozilla/readability` + `linkedom` | Local, free |
| Text to speech | Azure AI Speech (default), OpenAI, ElevenLabs, Piper (local) | All four support Hungarian; behind one `TtsProvider` interface |
| Audio | ffmpeg / ffprobe (installed) | Concatenation, loudness normalisation, encoding, exact timings |
| Web UI | React 19 + Vite 8, served by the server | Doubles as the desktop app |
| Mobile | Expo SDK 58 (React Native 0.88), expo-router, expo-audio, expo-sqlite, expo-file-system | Builds for Android on Windows; expo-audio covers background playback, lock-screen controls and pitch-corrected rate |
| Spaced repetition | `ts-fsrs` | Maintained FSRS implementation |
| Tests | Vitest (server, shared, web), jest-expo (mobile logic) | |

Versions are the latest stable on npm as of 2026-11-11. Pin exact versions in T01.

Tooling note (T01): `tsc` is TypeScript 7.0.2, installed under the alias `@typescript/native`. TypeScript 7.0 ships no programmatic API, so the `typescript` package name is aliased to `@typescript/typescript6` 6.0.2 for typescript-eslint, as recommended in the TypeScript 7.0 announcement. Remove both aliases once typescript-eslint supports TypeScript 7.

## Capability map

| Module id | Responsibility | Depends on |
|---|---|---|
| `shared` | Zod schemas and types: episode package, API DTOs, config | — |
| `providers` | LLM, search, fetch/extract, TTS interfaces with cloud, local and fake implementations | `shared` |
| `pipeline` | Research → notes → script → speech → assembled episode; resumable job runner; scheduler | `providers`, `shared` |
| `api` | HTTP API, auth/pairing, file serving, progress events | `pipeline`, `shared` |
| `web` | Desktop UI: topics, generation, library, player, settings | `api` |
| `mobile-core` | Local device acceptance, one-way downloads, USB import, offline library, background player | `api`, `shared` |
| `learning` | Hungarian script modes (server) and transcript, drill, vocabulary, SRS (mobile) | `pipeline`, `mobile-core` |

Build order: `shared` → `providers` → `pipeline` → `api` → `web`, `mobile-core` → `learning`.

## Success criteria

- **SC1** `pnpm gen "history of the Rubik's cube" --minutes 8` produces a playable audio file and a valid `episode.json` in under 6 minutes with the cloud profile, with at least 4 distinct cited sources.
- **SC2** Every sentence-level segment in `episode.json` has `startMs`/`endMs` within ±80 ms of the real audio (checked by an automated test on a fixture).
- **SC3** A subscribed topic produces an episode on schedule without user action, and does not repeat sources used by its earlier episodes.
- **SC4** A failed stage (network error, invalid LLM output) can be retried from that stage without redoing or re-paying for completed stages.
- **SC5** After explicit PC-side device acceptance, the phone can download a finished episode on home Wi-Fi; independently, a manually copied USB episode package can be imported. Both pass integrity checks and play in airplane mode with the screen off. Playback position survives app restart and stays on the phone.
- **SC6** In a Hungarian graded episode: the current sentence is highlighted during playback; tapping a sentence shows its translation; tapping a word shows lemma, meaning and morpheme breakdown, all offline.
- **SC7** Sentence drill works: auto-pause after each sentence, repeat current, previous/next, speed 0.5×–1.5× with pitch correction.
- **SC8** A saved word appears in the review queue; review ratings reschedule it via FSRS; state survives app restart locally. Reinstall recovery is not promised.
- **SC9 (deferred)** Automatic vocabulary-aware generation based on phone progress is out of scope. Any future explicit manual input or backup requires a separate owner decision; no phone progress is transferred automatically.
- **SC10** Switching `PROFILE=local` generates an English episode with no outbound calls except web page fetches (asserted with a network guard in the smoke test).
- **SC11** No API key appears in the web bundle, the APK, logs, or git history.

## Out of scope

iOS. Multiple users or accounts. Public hosting. Remote/cloud episode sync and automatic phone-to-PC progress or vocabulary transfer. App-store distribution. Voice cloning. Multi-host conversational banter with overlapping speech. Speech recognition or pronunciation scoring. Languages other than Hungarian for learning mode (the design keeps the target language as a config value, but only Hungarian is tested). Video.

## Boundaries

See `AGENTS.md` (Always / Ask first / Never).

## Open questions for the owner

1. **Native language** for translations and explanations: English assumed.
2. **Native desktop window**: is the browser-installed app enough, or is a tray app (Electron, T27) wanted?
3. **Voices**: one narrator, or two alternating hosts? The format supports both; one narrator is the default because it is cheaper and clearer for a learner.
4. **Monthly budget ceiling** for cloud APIs: the server enforces `MONTHLY_BUDGET_USD` (default 20) and refuses new jobs above it.
