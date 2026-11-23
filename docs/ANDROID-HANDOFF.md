# Android app handoff

Self-contained brief for an agent taking over the Android app (`apps/mobile`). Written against `main` at `b1ff6fe` (2026-11-17). Read this file, then `AGENTS.md`, then the files it points to. Verify every statement against the code before relying on it; the code wins.

## 1. Product context

Podcast Studio turns a topic into a researched, spoken podcast on the owner's Windows PC (`apps/server` + `apps/web`, also packaged as an Electron desktop app in `apps/desktop`). The Android app is the **offline listening and Hungarian-learning client**.

Owner decisions that bound this app (see `docs/SPEC.md`):

- **Android only.** Personal use, no store release; the APK is installed over USB.
- **One-way, manual, USB-only transfer** from PC to phone. No Wi-Fi/LAN transfer, pairing, device APIs, cloud sync, or phone-to-PC upload of playback or vocabulary. Wireless task T17 is cancelled; do not revive it.
- **All learner state stays on the phone:** playback positions, speed, transcript settings, saved words, review history.
- Learner: Hungarian beginner (A1–A2), explanations in English.

## 2. Status at a glance

| Task (`tasks/todo.md`) | Code | Automated tests | Physical-device acceptance |
|---|---|---|---|
| T18 background player, bundled sample | Done | Yes | **Open** |
| T19 USB package import + offline library | Done | Yes | **Open** |
| T22 transcript, translation, word sheet | Done | Logic only | **Open** |
| T23 sentence drill, speed, loop | Done | State machine | **Open** |
| T24 vocabulary + FSRS review | Done | Yes | **Open** |
| T25 vocabulary-aware generation | Deferred by owner | — | — |

All of T18–T24 are unchecked in `tasks/todo.md` because the device checks have not been done. The owner has installed a test APK and reported that it runs; the detailed checklists in §9 have not been completed.

Not implemented: settings screen, episode deletion or replacement, listening-time tracking, "report error" on a word, a SQLite episode index (the library is the file system), release signing, app icon/branding.

## 3. Stack

From `apps/mobile/package.json` (exact pins):

- Expo SDK 58 (`expo` 58.0.24), React Native 0.88.1, React 19.3
- `expo-router` (file-based routes in `app/`), `expo-dev-client`
- `expo-audio` (player, background playback, lock screen, rate)
- `expo-file-system` (new `File`/`Directory`/`Paths` API, system file picker)
- `expo-sqlite` (both the `kv-store` key-value API and a real database)
- `ts-fsrs` 5.4.2 (spaced repetition)
- `shared` workspace package: zod schemas, notably `EpisodeSchema`
- Tests: Vitest 5 (not Jest), plain Node environment, fakes for native modules

These versions are newer than most model training data. Read the installed type definitions or current Expo docs (append `.md` to any `docs.expo.dev` URL) before using an API.

`app.json`: name "Podcast Studio", scheme `podcaststudio`, Android package **`app.podcaststudio.mobile`** (do not change: it would install as a separate app and lose data), plugins `expo-router`, the local object-path plugin, and `expo-audio` with `enableBackgroundPlayback: true`, `recordAudioAndroid: false`.

## 4. Source map

```
apps/mobile/
  app.json                      Expo config (package id, plugins)
  app/_layout.tsx               Stack navigator: index "Player", library, review
  app/index.tsx                 Player for the bundled sample episode
  app/library.tsx               Library + "Import USB package"
  app/offline.tsx               Player for an imported episode (transcript, drill, loop)
  app/review.tsx                Vocabulary review (FSRS) with sentence-audio replay
  assets/audio.m4a, episode.json  Bundled LibriVox sample package (public domain)
  plugins/with-android-object-path.cjs  Config plugin: CMAKE_OBJECT_PATH_MAX=240
  src/offline-files.ts          USB import, staging, verification, library listing
  src/offline-store.ts          Stage → verify → publish/discard transaction helper
  src/offline-playback.ts       Per-episode position store + seek checkpoint guard
  src/sample.ts                 Parses the bundled sample with EpisodeSchema
  src/sample-playback.ts        Sample position store (+ unused local queue)
  src/position.ts               clampPosition, formatTime
  src/speed.ts, SpeedControl.tsx  0.50–1.50× in 0.05 steps, saved per mode
  src/transcript.ts             segmentAt, tokenParts (word ↔ token alignment)
  src/TranscriptView.tsx        Transcript, translation modes, word sheet, Save word
  src/drill.ts                  Pure state machine: drill / loop / navigation
  src/vocabulary.ts             SQLite vocabulary store, due queue, progress, streak
  src/local-vocabulary.ts       Opens local-vocabulary-v1.db once
  src/review.ts                 ts-fsrs wrappers, due/new-card selection
  src/playback-queue.ts, playback-sync.ts  Legacy sync code, not connected (see §8)
  src/*.test.ts                 53 Vitest tests
```

Desktop side of the transfer, for reference: `apps/server/src/episode-routes.ts` (`GET /api/episodes/:id/usb/episode.json|audio.m4a`, loopback only, re-verifies size and SHA-256 before serving), `apps/web/src/UsbExport.tsx` (instructions + download links in desktop Library), `apps/server/src/cli/usb-export.ts` (`pnpm usb:export <package-dir> <new-dir>`).

## 5. Episode package format

A package is two files with fixed names: `episode.json` and `audio.m4a` (AAC). `episode.json` must pass `EpisodeSchema` in `packages/shared/src/episode.ts`:

- `schemaVersion: 1`, `id`, `title`, `summary`, `createdAt`, `durationMs`, `mode` (`standard` | `graded` | `bilingual`), `lang`, `nativeLang`, optional `level`
- `audio: { file: "audio.m4a", bytes, sha256 }` (64 lowercase hex)
- `segments[]`: `id`, `kind`, `speaker`, `lang`, `text`, `startMs`, `endMs`, optional `translation`, `tokens[]`, `repeatOf`, `rate`, `pauseAfterMs`, `sourceIds`
- `tokens[]`: `surface`, `lemma`, `pos`, `gloss`, optional `morphemes[{form, meaning}]`, `isTarget`
- `chapters[]`, `sources[]`, optional `targetVocabulary[]`, `generation {profile, llm, tts, voice, costUsd}`

Changing this schema affects server, desktop and phone and is an "ask first" change under `AGENTS.md`.

## 6. Functionality, screen by screen

### Player (`app/index.tsx`): bundled sample

- Plays `assets/audio.m4a` (LibriVox "The Mouth", ~10 min, no transcript).
- Audio mode: `playsInSilentMode`, `shouldPlayInBackground`, `interruptionMode: "doNotMix"`.
- On play, calls `player.setActiveForLockScreen(true, {title, artist})`. expo-audio documents this as required for sustained background playback on Android.
- Restores the saved position once the audio is loaded; disables Play until restore finishes. Back 15 s / Forward 30 s. Speed control.
- Saves position at most once per whole second, every 5 s while playing, on pause, and resets to 0 when finished. Read/seek/save failures show a message and stop further saves rather than overwriting a good checkpoint.

### Library (`app/library.tsx`)

- Explains the USB workflow; button **Import USB package**.
- Import flow: system picker for `episode.json`, then a second picker for `audio.m4a`; live status text ("Copying and verifying package…"); button disabled while importing; cancel at either picker leaves the library unchanged.
- Lists the bundled sample with its saved position, a "Review vocabulary" button, and one button per verified imported episode (opens `/offline?id=…`).

### USB import and offline library (`src/offline-files.ts`, `src/offline-store.ts`)

Storage root: `<app documents>/offline-episodes-v1/`.

1. Parse `episode.json` with `EpisodeSchema`; reject on failure.
2. Reject if a committed episode with the same `id` already exists (no replacement, even if the existing audio is damaged), to protect local data.
3. Create `staging-<random>/`, copy the picked audio into it, check byte count and SHA-256 against `episode.audio`.
4. On success: write `episode.json`, move the directory to `published-<random>/`, re-verify the moved audio, then write `commit.json` `{committed: true}`. Only directories with that marker (or legacy `episode-*` directories with verified audio) are listed.
5. On any failure: delete only the staging directory; existing episodes and positions are untouched. A module-level flag prevents concurrent imports.

`listOfflineEpisodes()` re-hashes every episode's audio on each call (Library focus, opening an episode, Review). Correct but slow with many or long episodes: a known performance item.

The SHA-256 check detects corruption, not a malicious package: the user must pick files from a trusted copy.

### Offline player (`app/offline.tsx`): imported episodes

- Same audio mode, lock-screen, restore and checkpoint rules as the sample player; status updates every 100 ms; positions saved per episode.
- `createSeekCheckpoint` serialises seeks so a stale clock update or an older seek cannot overwrite a newer checkpoint, and a failed seek is not saved.
- Speed control (saved per episode `mode`).
- Shows the transcript when the episode has segments; otherwise only playback.

### Transcript and word sheet (`src/TranscriptView.tsx`, `src/transcript.ts`)

- Current sentence (half-open `[startMs, endMs)`) highlighted, bold, auto-scrolled.
- Tap a sentence: seek to it (or select it in drill mode) and, in "tap" mode, toggle its translation.
- Translation mode: **Tap to show** (default) / **Always show** / **Never show**, saved.
- Words that match a token are underlined. `tokenParts` aligns tokens to whole words only (Unicode letters/digits/marks), preserving punctuation and spacing; unmatched tokens are skipped rather than mis-attached.
- Tap a word: bottom sheet with surface, lemma, part of speech, gloss, morphemes, **Save word** (stores token + sentence + translation + episode id + segment timing), and the note "Reporting errors is not available yet."
- Long-press a sentence or press **Loop sentence N**: loop that sentence.

### Sentence drill, loop, speed (`src/drill.ts`, `src/speed.ts`)

`transition(state, event, segments)` is a pure state machine; the screen applies its effects (`pause`, `seek`).

- Modes: `off`, `drill` (auto-pause at each sentence end), `loop` (repeat one sentence until dismissed).
- Drill controls: Turn drill on/off, Previous, Repeat, Next, Plays 1×/2×/3× (play each sentence N times before pausing). Play while paused in drill resumes at the next sentence.
- Sentences with `endMs <= startMs` are skipped as seek targets.
- Speed: 0.50×–1.50× in 0.05 steps, pitch-corrected (`shouldCorrectPitch = true`), saved per mode; invalid stored values fall back to 1×.
- Timing limit: driven by 100 ms status updates and JavaScript timing, not sample-accurate. Pauses can overshoot, especially in the background or with the screen off. Generated episodes leave a silence after each sentence (`pauseAfterMs`) which absorbs this; that must be confirmed on a device.

### Vocabulary review (`app/review.tsx`, `src/vocabulary.ts`, `src/review.ts`)

- Database `local-vocabulary-v1.db`: table `local_vocabulary(id, lemma UNIQUE, word JSON, card JSON, introduced_day)`, table `local_review_days(day)` filled by a trigger when a card is reviewed.
- Saving a word whose lemma is already saved is ignored (first sentence wins).
- Due queue: all due learning/review cards plus at most **10 new cards per day** (`selectDueCards`). FSRS via `ts-fsrs` with fuzz disabled.
- Card: lemma; **Play sentence** replays the original segment from the episode's audio if that episode is still on the phone (otherwise "Original audio is unavailable"); **Show answer** reveals gloss, sentence, translation, morphemes; ratings Again / Hard / Good / Easy.
- Progress line: due now, learning, known (FSRS review state), reviewed today, review streak in days (counted from when the review-day table was introduced; older history is not inferred).

## 7. Data kept on the phone

| Data | Where | Key / name |
|---|---|---|
| Imported packages | Documents dir | `offline-episodes-v1/published-*/{episode.json,audio.m4a,commit.json}` (legacy `episode-*`) |
| Sample position | `expo-sqlite/kv-store` | `sample-position-seconds` |
| Sample local queue (unused) | kv-store | `sample-local-playback-v1` |
| Imported episode positions | kv-store | `offline-position-v1:<episodeId>` |
| Speed per mode | kv-store | `playback-speed-v1-<mode>` |
| Transcript translation mode | kv-store | `transcript-translation-mode-v1` |
| Vocabulary and reviews | SQLite | `local-vocabulary-v1.db` |

Uninstalling the app deletes all of this. There is no backup or export. Reinstall recovery is not promised (T24).

## 8. Known gaps and code-review notes

1. **Legacy sync code is dead:** `playback-queue.ts` and `playback-sync.ts` came from the cancelled phone-to-PC sync. `sample-playback.ts` still writes the sample's position into a local queue that nothing sends. Removing it is a cleanup task; ask the owner first because the policy is to preserve code and history.
2. `app/_layout.tsx` registers `index`, `library`, `review` but not `offline`; expo-router still serves `/offline` with a default header title. Add a `Stack.Screen` with a proper title.
3. The library re-hashes all audio on every listing (see §6). Consider caching verification results keyed by file size and modification time.
4. No delete or replace for imported episodes; a damaged committed episode blocks re-import of the same id.
5. No settings screen (architecture §7 lists one), no listening-time statistics, no "report error".
6. Lock-screen activation happens only when the user presses Play in the app; check behaviour after resuming from the lock screen and after audio-focus loss.
7. UI is minimal stock React Native components (`Button`, `Text`), no theming, icons or app icon.
8. `version` is 0.0.0 and no `versionCode` is set in `app.json` (prebuild default). Set them for any build meant to update an installed copy cleanly.

## 9. Physical-device acceptance still required

Use a build with the JavaScript bundle embedded (§10). **Never uninstall the existing app to run a test:** that deletes the owner's library and progress.

T18, sample player:
1. Play 10 minutes with the screen off.
2. Pause and resume from the lock screen.
3. Keep playing while switching apps.
4. Force-stop, reopen, and check the position is restored.

T19, USB import:
1. On the PC, open desktop Library → "Export for Android via USB", download both files into a new empty folder, copy it to the unlocked phone over USB.
2. In the app's Library, select `episode.json` then `audio.m4a`; check the status message, the disabled button, and that the title appears and plays.
3. Cancel each picker in turn: library unchanged.
4. Re-import the same package: rejected, saved position unchanged.
5. Try missing, malformed, mismatched, truncated and interrupted files: no partial episode appears, existing episodes intact; then a valid import succeeds.
6. Airplane mode, screen off, lock-screen controls, app switching, force-stop and reopen: position restored, nothing uploaded when connectivity returns.
7. With enough episodes to scroll, open the last one; check large text and TalkBack.

T22–T24, needs a generated Hungarian graded or bilingual episode with segments and tokens:
1. Highlighting follows audio; tapping a sentence seeks.
2. Translation modes work.
3. The word sheet opens and saves a word, all in airplane mode.
4. Drill pauses land inside the inter-sentence silence, including with the screen off.
5. Repeat ×2/×3, previous/next, loop and dismiss all work.
6. Saved words appear in Review and Play sentence works.
7. Ratings reschedule cards.
8. State survives a force-stop.

Record results in `tasks/todo.md` before ticking any of T18–T24.

## 10. Build, test, install

From the repository root (Node 22, pnpm 12):

```sh
pnpm install --frozen-lockfile
pnpm --filter mobile test        # 53 Vitest tests, no device needed
pnpm --filter mobile typecheck
pnpm lint                        # whole repo, includes mobile typecheck
```

Android build requirements: JDK 17 (`JAVA_HOME`), Android SDK with platform-tools/adb and the compile SDK required by Expo SDK 58 (`ANDROID_HOME`), physical phone with USB debugging (`docs/SETUP.md` → Phone development). No emulator or Android Studio is needed.

**Windows path-length workaround (required on Windows):** native CMake/Ninja paths overflow in a normal checkout. Use a fresh clone at a very short path (for example a single-letter folder at a drive root), set `PNPM_CONFIG_NODE_LINKER=hoisted` in that shell for every pnpm command, and set `GRADLE_USER_HOME` to a short directory. Do not switch the linker inside an existing checkout. The config plugin adds `CMAKE_OBJECT_PATH_MAX=240` to the generated Gradle file and fails loudly if the Expo template changes. Do not set the hoisted linker in your normal development shell: it breaks the default install.

```sh
pnpm install --frozen-lockfile
pnpm --filter mobile exec expo prebuild --platform android --no-install
cd apps/mobile/android
gradlew.bat assembleDebug          # dev build: needs the Metro dev server
gradlew.bat :app:assembleRelease   # standalone TEST build with embedded JS bundle
```

- Debug APK: `app/build/outputs/apk/debug/app-debug.apk`; requires Metro (`pnpm --filter mobile android` builds, installs on the USB phone and starts it).
- Release-variant APK: `app/build/outputs/apk/release/app-release.apk`. The generated Expo config signs it **with the debug key**: fine for the owner's phone, not a production release. Check it contains `assets/index.android.bundle` before copying it to the phone.
- Install or update: `adb install -r <apk>`. Android updates only with a matching signing key. If install reports a signature mismatch, **do not uninstall**; resolve signing first. The debug keystore comes from Expo prebuild and is identical across the checkouts inspected so far; verify before relying on it. A real release keystore and its safekeeping is an open owner decision.
- `expo prebuild --clean` deletes and regenerates `android/`; back up local native changes first. The `android/` directory is git-ignored.

## 11. Rules for the next agent

- Follow `AGENTS.md`: one task at a time, tests first for logic, commit per task, do not push unless asked.
- Keep the owner's machine details (user name, home paths, hardware, installed software) out of tracked files and commit messages; they belong only in the git-ignored `docs/LOCAL.md`.
- Never delete or rewrite history, and never uninstall the app on the owner's phone, without an explicit yes.
- No wireless transfer, sync or upload of any phone data. Schema or package-format changes are ask-first.
- Hungarian learning content is generated by the PC (`docs/LEARNING-MODE.md`); the phone only displays what the package contains.

## 12. Further reading

`docs/ANDROID-HANDOFF.md` is linked from `apps/mobile/README.md`. Also read `apps/mobile/README.md` (build details, acceptance notes), `docs/SPEC.md` (scope, SC5–SC8), `docs/ARCHITECTURE.md` §4 and §7, `docs/LEARNING-MODE.md` §3, `tasks/todo.md` T18–T25, `docs/SETUP.md`.
