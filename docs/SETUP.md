# Setup

## Required tools

| Tool | Needed for |
|---|---|
| Node.js 22, pnpm, git | everything |
| ffmpeg / ffprobe on PATH | audio assembly |
| JDK 17 (`JAVA_HOME` set) | Android build |
| Android SDK: cmdline-tools, platform-tools (adb), platform `android-36`, build-tools 36.0.0, licences accepted (`ANDROID_HOME` set) | Android build |
| Docker | SearXNG, local profile only |
| Ollama | local profile only |

On Windows, the JDK and Android SDK can be installed without admin rights using Scoop: `scoop bucket add java`, then `scoop install java/temurin17-jdk main/android-clt`, then `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`. Open a new terminal afterwards to pick up the environment variables. Gradle downloads the NDK and CMake on the first Android build (several GB).

Android Studio and an emulator are not required: development uses a physical phone.

The state of the owner's own machine (paths, versions, hardware) is recorded in `docs/LOCAL.md`, which is git-ignored.

## Owner actions

### 1. API keys (before the first real run, task T05 onward)

Copy `.env.example` to `.env` and fill in:

- **LLM**: an Anthropic or OpenAI API key.
- **Search**: a Tavily key (free tier exists) or a Brave Search API key.
- **Speech**: an Azure AI Speech resource key and region (Azure portal → create "Speech" resource; the free F0 tier is enough to start).

Never paste keys into a chat with an agent; put them in `.env` yourself.

ChatGPT generation has a hard per-request deadline of 300 seconds for scripts and 120 seconds for other stages. To change these, set the server process environment variables `CHATGPT_SCRIPT_TIMEOUT_MS` and `CHATGPT_STAGE_TIMEOUT_MS` before starting it (these two overrides are not read from `.env`). Values must be integer milliseconds between 1000 and 900000. A timeout or cancellation does not prove remote generation stopped; do not automatically retry. Follow the manual recovery instructions below and leave the recovery marker in place if remote work cannot be confirmed stopped. The progress log reports only event and byte counts, not response content.

### 2. Phone (before task T18)

1. Settings → About phone → tap **Build number** seven times.
2. Settings → Developer options → enable **USB debugging**.
3. Connect by USB, accept the prompt on the phone, then run `adb devices`: the phone must show as `device`.

### 3. Remote access (before task T19, optional but recommended)

Install Tailscale on the PC and the phone and sign in to the same account. Then `tailscale serve --bg 4747` gives an HTTPS address the phone can reach from anywhere. Without it, sync works only on home Wi-Fi.

### 4. Windows firewall

When the server first listens on the LAN (`HOST=0.0.0.0`), allow Node.js on **private** networks only.

## Windows login autostart

After installing dependencies, `pnpm autostart:install` registers a Windows Task Scheduler login task for this checkout and current user; it does not start the server immediately or overwrite an existing task. `pnpm autostart:remove` removes it only if its action still matches this checkout and the current Node executable. If Node or the checkout moves, inspect the old task in Task Scheduler before removing it manually. Neither command deletes application data. The server requires its usual configuration and dependencies at login.

At login the launcher builds the web interface before starting the server; a build failure prevents startup rather than serving a stale build. Open `http://localhost:4747` (or the configured port) for the same-origin interface. After changing web code, restart the task to rebuild it. For manual production startup, run `pnpm --filter web build` before `pnpm --filter server start`. Browser installation and the login task still require manual verification.

## Local profile (task T26)

The Settings profile selector currently saves a preference only; it does not switch providers. Set `PROFILE=local` in `.env` and restart to configure the server. Until the job runner is integrated, the HTTP job endpoints conservatively reject graded and bilingual jobs and retries if either the startup profile or the saved preference is local. To explicitly accept the quality risk, set `ALLOW_LOCAL_LEARNING=1` in `.env` and restart. This guard does not cover direct runner or scheduler calls, which must enforce the same policy when implemented. Local search and article retrieval still use the network; a local profile is not an offline guarantee.

- LLM: `ollama pull` the model named in `.env`. Cloud-named models are rejected, but names alone cannot verify custom Modelfiles or aliases, and a loopback proxy could forward prompts remotely. For a trusted Ollama server, disable its cloud features with `OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud` in server configuration and restart it; see [Ollama's local FAQ](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features). This does not control other services or network access. On a CPU-only machine expect small models at slow speed: fine for English drafts, not for graded Hungarian.
- **Desktop generation recovery:** Stop every server and generation CLI before upgrading; older versions do not honor the new lock, so mixed versions are unsafe. The lock file `desktop-generation-lock.sqlite` and state file `desktop-generation-state.sqlite` are in `DATA_DIR`; never delete the lock file while any server or CLI may be running. The state file records work that may not have stopped. A crash, failed external call, or shutdown that cannot drain work may block generation. Old queued or running jobs remain visible and unresolved; they are not resumed or automatically marked interrupted. To recover, stop all servers and CLIs, independently verify that their Piper and ffmpeg children and any Ollama requests have finished (a missing PID alone is not proof), and inspect any unfinished publication and job data. Once you have established that no old worker can write or publish, manually remove only `desktop-generation-state.sqlite` and its SQLite journal files, then restart. Do not delete job or episode data as part of recovery. If you cannot establish quiescence, leave the state file in place and do not restart generation.
- Search: `docker compose -f infra/docker-compose.searxng.yml up -d`.
- TTS: the optional Piper provider expects Piper 1.8.0 in `PIPER_DIR/venv` and voice files in `PIPER_DIR/voices` (`PIPER_DIR` defaults to `infra/piper`). Install it in an isolated Python virtual environment with `python -m venv infra/piper/venv`, then use that environment's Python to run `-m pip install piper-tts==1.8.0`. Piper and its ONNX runtime dependencies include native code. The upstream maintained engine is [GPL-3.0-or-later](https://github.com/OHF-Voice/piper1-gpl/blob/v1.8.0/COPYING); review the license before installing or redistributing.
- Voice download is separate and explicit: after reviewing the restrictions below, run `node scripts/piper-voices.mjs --accept-licenses` from the repository root. Pass a directory after the flag if `PIPER_DIR` differs. The script downloads pinned English `en_US-lessac-medium` and Hungarian `hu_HU-anna-medium` model, config and model card files and verifies SHA-256 before writing. It refuses to overwrite existing files with different hashes. Configure the corresponding `TTS_VOICE_*` values in `.env`; do not leave the Azure voice defaults when using Piper. Other Piper voices can be placed in the voices directory as matching `.onnx` and `.onnx.json` pairs and selected by their filename without the extension.
- **Voice restrictions:** the English Lessac voice is trained on the [Lessac Blizzard 2013 corpus](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html), whose license limits use to research/exploration and excludes commercial synthesis. Anna's own dataset is CC0 but its card says it was fine-tuned from Lessac, so Lessac restrictions may also apply. The Piper project does not grant rights to voice weights; see its [voice licensing guidance](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/LICENSING.md) and the downloaded model cards. Do not assume these models are suitable for commercial use or redistribution.

## Handing tasks to a coding agent

From the repo root, start the agent (Claude Code, Codex, OpenCode or similar) and say:

> Read AGENTS.md, then do the first unchecked task in tasks/todo.md.

One task per session. Review the diff and the task's Verify output before starting the next.
