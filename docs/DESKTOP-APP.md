# Standalone desktop app: architecture and build plan

Status: **planned, not started.** Written against branch `t13-http-api` at `c036b2f`. Re-check the "Current code facts" section before starting; paths and call sites may have moved.

## 1. Goal and scope

Turn the PC side of Podcast Studio into an installed Windows application: one installer, a Start-menu entry, a window, a tray icon, no terminal, no repository checkout, no hand-edited `.env`.

In scope: Windows 11 x64, one user, personal use, unsigned installer.

Out of scope: macOS and Linux builds, code signing, auto-update, store distribution, bundling Ollama, SearXNG or Piper. The local profile stays "bring your own tools".

## 2. Entry gate

Do not start until both are true:

1. T16 is accepted (desktop web UI complete), so the UI and settings routes have stopped moving.
2. At least one real episode has been generated end to end with real providers (T12 acceptance).

Packaging freezes path and configuration handling. Doing it earlier means doing it twice.

## 3. Architecture

```
┌──────────────────────── Podcast Studio.exe (Electron) ────────────────────────┐
│ main process                                                                  │
│  ├─ single-instance lock, tray icon, window lifecycle, start-at-login         │
│  ├─ secrets store (Electron safeStorage → Windows DPAPI)                      │
│  ├─ server supervisor ── spawns ──►  bundled node.exe  server.mjs             │
│  │       picks a free port, passes config + secrets as environment,           │
│  │       waits for /api/health, restarts on crash, asks for clean shutdown    │
│  ├─ BrowserWindow ──► http://127.0.0.1:<port>/        (existing web UI)       │
│  └─ Keys window ──► local page + preload bridge       (write-only key entry)  │
│                                                                               │
│ resources/                                                                    │
│   node/node.exe            the Node runtime the server is tested on           │
│   server/server.mjs        bundled server code                                │
│   server/node_modules/     better-sqlite3 only (native, not bundled)          │
│   server/prompts/*.md  server/migrations/                                     │
│   web/                     built web UI                                       │
│   bin/ffmpeg.exe  bin/ffprobe.exe                                             │
└───────────────────────────────────────────────────────────────────────────────┘
User data: %LOCALAPPDATA%\PodcastStudio\   data\ (app.db, episodes, jobs, cache)
                                           secrets.bin   settings.json   logs\
```

### Decisions and reasons

| Decision | Choice | Reason |
|---|---|---|
| Shell | Electron | The UI is already a web app served by the server. Electron needs no rewrite and no new toolchain. Tauri would need Rust and still a Node sidecar. |
| How the server runs | Child process under a **bundled `node.exe`**, not inside Electron | The server then runs on exactly the runtime it is developed and tested on. `better-sqlite3` keeps its normal prebuilt binary, so there is no rebuild against Electron's ABI, which is the usual packaging failure. A crash in a generation job cannot take the window down. Cost: larger download. |
| Server packaging | One bundled ES module (`server.mjs`) plus copied assets | The server runs from TypeScript source through `tsx` today. A packaged app must not depend on dev tooling. Native and file-loading modules stay external. |
| Window content | The existing HTTP origin on loopback | Zero UI changes. The server's existing Host and Origin checks keep applying. |
| Secrets | Entered in a separate Electron window, encrypted with `safeStorage`, injected into the server's environment at spawn | The web UI must never receive or return keys (SPEC SC11). The server already lets real environment variables override `.env`, so it needs no secrets code. |
| Port | Chosen free port, default 4747, passed as `PORT` | A fixed port can be taken by another program. |
| Background operation | Closing the window hides to tray; quitting is explicit | Scheduled topics (T14) need the server running. |
| Start at login | Electron login-item setting | Replaces the Task Scheduler script for installed copies. The script stays for repository use. |

Alternative kept in reserve: run the server in Electron's `utilityProcess` and rebuild `better-sqlite3` for Electron. Smaller download, more moving parts. Choose it only if size becomes a real concern.

## 4. Current code facts the work depends on

Verify each before changing it.

| Fact | Where | Needed change |
|---|---|---|
| `.env` and relative `DATA_DIR` resolve from the repository root (`REPO_ROOT`) | `apps/server/src/config.ts` | Root directory must be injectable from the environment; `loadConfig` already accepts `rootDir`. |
| `PIPER_DIR` resolves from `REPO_ROOT` | `apps/server/src/providers/index.ts` | Resolve from the same injectable root. |
| Web UI directory is `../../web/dist` relative to the source file | `apps/server/src/main.ts` | Take it from one resource-path helper. |
| Migrations load relative to the source file | `apps/server/src/db/index.ts` | Same helper. |
| Prompt templates load relative to the source file | `apps/server/src/pipeline/prompts.ts` | Same helper. |
| Version is read from `../package.json` via `createRequire` | `apps/server/src/app.ts` | Inject at bundle time. |
| `ffmpeg` is invoked by bare name | `apps/server/src/audio/assemble.ts`, `apps/server/src/providers/tts/cache.ts` (and any `ffprobe` call) | Resolve through one function that honours an override. |
| Server has no graceful-shutdown trigger; the database closes in an `onClose` hook | `apps/server/src/main.ts` | Add a shutdown trigger that works on Windows. |
| Loopback requests are checked for Host and Origin | `apps/server/src/app.ts` | Keep. Confirm the check accepts the chosen port. |
| Start at login uses Task Scheduler and repository paths | `scripts/autostart.mjs` | Leave as is. |

## 5. Design details

### 5.1 Resource paths

Add one module, `apps/server/src/paths.ts`, exporting functions for: web root, migrations directory, prompts directory, configuration root, and the ffmpeg and ffprobe executables. Each reads an environment variable first (`PODCAST_STUDIO_RESOURCES`, `PODCAST_STUDIO_HOME`, `FFMPEG_PATH`, `FFPROBE_PATH`) and falls back to today's repository-relative behaviour. Replace the scattered `import.meta.url` path maths with calls to it. Repository runs must behave exactly as before; the existing test suite is the proof.

`FFMPEG_PATH` and `FFPROBE_PATH` may belong in the shared config schema. That is an ask-first change under `AGENTS.md`; reading them only in `paths.ts` avoids it.

### 5.2 Server bundle

A build script produces `dist-desktop/server/`:

- `server.mjs`: the server entry bundled to one ES module. `better-sqlite3` is external. Check whether `linkedom`, `@mozilla/readability` and the AI SDK packages bundle cleanly; make any that do not external and copy them.
- `node_modules/better-sqlite3` with its prebuilt binary for the bundled Node version, plus its runtime dependencies.
- `prompts/`, `migrations/` copied verbatim.

The bundler is a new direct dev dependency. `esbuild` is already present transitively through `tsx`; adding it directly, and adding Electron and the installer tool, are ask-first items because they ship native binaries.

Acceptance for the bundle on its own: `node dist-desktop/server/server.mjs`, started from an empty temporary directory with only environment variables, serves the UI and passes a fake-provider generation.

### 5.3 Supervisor

Start sequence in the Electron main process:

1. Take the single-instance lock; a second launch focuses the existing window.
2. Read `settings.json`; decrypt `secrets.bin`.
3. Choose a port: the saved one if free, else another free one.
4. Spawn `resources/node/node.exe resources/server/server.mjs` with a clean environment: `HOST=127.0.0.1`, `PORT`, `DATA_DIR`, the resource and home variables, the ffmpeg paths, provider settings and decrypted keys. Do not inherit the parent's full environment.
5. Poll `/api/health` until ready, then open the window. Show a plain error page with the log location if it does not come up.
6. On unexpected exit, restart with backoff, at most three times, then show the error page.

Shutdown: Windows has no catchable SIGTERM for a plain child process. Use a dedicated channel: the server exits cleanly when its standard input closes, or on an IPC message. Wait a bounded time, then kill. A job interrupted this way must be resumable; T12 added explicit resume of interrupted jobs, so verify that path instead of adding a new one.

Changing a key or provider setting restarts the server child. Refuse or defer the restart while a job is running.

### 5.4 Secrets

- Stored as one `safeStorage`-encrypted blob in `secrets.bin`. This protects against other Windows accounts and casual file copying, not against programs running as the same user. State that honestly in the Keys window.
- The Keys window is a local page with a preload bridge exposing three calls: list key names with set / not set, set a key, clear a key. It never returns a value. Context isolation on, Node integration off, navigation and new windows blocked.
- The main window gets no preload bridge at all.
- Keys never go to the renderer, the logs, crash output or `settings.json`.

### 5.5 Electron hardening

Main window: `contextIsolation` on, `nodeIntegration` off, sandbox on, no preload. Allow navigation only to the app's own origin; open every other link in the system browser. Deny all permission requests. No remote module. A Content-Security-Policy for the Keys page.

### 5.6 Data location and first run

Installed copies keep everything under `%LOCALAPPDATA%\PodcastStudio\`. On first run, offer to **copy** an existing repository `data/` directory chosen by the user. Never move or delete the original. Uninstalling leaves user data in place.

### 5.7 Logging

Server stdout and stderr go to a rotating file under `logs\`. Apply the server's existing redaction; add a test that a configured key value never appears in a log line. A tray menu item opens the log folder.

### 5.8 Bundled binaries and licences

- ffmpeg and ffprobe: ship a build whose licence fits the intended use. For personal use any build works. Record the build source, version and licence in a `THIRD-PARTY.md` shipped with the app. Redistribution to others needs the licence terms checked first.
- Node: ship the same major version the tests run on. Record version and licence.
- Piper engine and voices are not bundled; `docs/SETUP.md` already records their licence restrictions.

## 6. Build plan

New workspace `apps/desktop`. One task per session, in order. Each is independently verifiable.

| Task | Outcome | Verify |
|---|---|---|
| **D1 Path abstraction** | `paths.ts` in the server; all resource, config-root and ffmpeg lookups go through it; repository behaviour unchanged | Full existing suite passes untouched. New tests: each override variable redirects its path; defaults equal the old values. |
| **D2 Server bundle** | Build script producing `dist-desktop/server/` as in 5.2, plus the built web UI | Start the bundle under plain Node from an empty temp directory with env only: health responds, UI loads, a fake-provider job completes, migrations apply to a new database. |
| **D3 Clean shutdown** | Shutdown channel in the server; interrupted job resumes | Test: start, begin a fake job, close the channel, process exits within the limit, database is not locked, restart resumes the job. |
| **D4 Electron shell** | `apps/desktop`: supervisor, window, tray, single instance, start-at-login toggle, error page, hardening from 5.5 | Unit tests for port choice, environment construction, restart backoff with a fake child. Manual: launch, close to tray, reopen, quit, second launch focuses the first. |
| **D5 Keys window and secrets** | 5.4 implemented; server restart on change | Tests: bridge exposes no read call; blob round-trips; a set key reaches the child's environment; key absent from logs and from every HTTP response. Manual: enter keys, run `smoke` equivalent from the UI or generate an episode. |
| **D6 Installer and first run** | Installer with bundled Node and ffmpeg, per-user install, data-copy offer, `THIRD-PARTY.md` | On a Windows account without Node, pnpm, ffmpeg or the repository: install, enter keys, generate and play one real episode, reboot, app starts at login, scheduled topic runs. Uninstall leaves data. |

Dependencies: D1 → D2 → D3 → D4 → D5 → D6. D1 to D3 change only the server and are safe to land early, even before the entry gate, because they are behaviour-preserving and tested. D4 onward wait for the gate.

### Owner decisions needed before D4

1. Approve the new dependencies: Electron, an installer builder, a bundler.
2. Accept an unsigned installer (Windows SmartScreen warning on first run) or buy a signing certificate.
3. Whether the app should start at login by default.
4. Whether the browser-installed app and Task Scheduler script stay documented alongside, or are retired for installed use.

## 7. Risks

| Risk | Mitigation |
|---|---|
| A dependency does not bundle (dynamic requires, data files) | D2 treats it as external and copies it; the temp-directory start test catches misses. |
| Prebuilt `better-sqlite3` binary missing for the bundled Node version | Pin the bundled Node to the version CI and development use; D2's test runs under that exact binary. |
| Killed child corrupts or locks the database | WAL mode is already on; D3 adds the clean path and tests the unclean one. |
| Another local program or web page calls the loopback API | Existing Host and Origin checks; no secrets reachable over HTTP; port is not fixed. |
| Keys leak through logs or the UI | Write-only bridge, redaction test, HTTP-response test in D5. |
| Installer size | Expected to be a few hundred megabytes with Electron, Node and ffmpeg. Acceptable for personal use; the `utilityProcess` alternative removes the second Node if it matters. |
| Stack newer than model knowledge (Electron, bundler, installer APIs) | Per `AGENTS.md`: read current documentation and installed type definitions before coding. |

## 8. What does not change

The pipeline, providers, HTTP API, web UI, mobile app and the episode package format. `pnpm dev`, `pnpm gen` and the repository workflow keep working exactly as today. The desktop app is a second way to start the same server.
