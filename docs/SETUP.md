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

- LLM: `ollama pull` the model named in `.env`. On a CPU-only machine expect small models at slow speed: fine for English drafts, not for graded Hungarian.
- Search: `docker compose -f infra/docker-compose.searxng.yml up -d`.
- TTS: Piper binary and voices are downloaded by `pnpm run piper:install`.

## Handing tasks to a coding agent

From the repo root, start the agent (Claude Code, Codex, OpenCode or similar) and say:

> Read AGENTS.md, then do the first unchecked task in tasks/todo.md.

One task per session. Review the diff and the task's Verify output before starting the next.
