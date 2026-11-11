# Setup

## Installed on this PC (verified 2026-11-11)

| Tool | Version | Location / note |
|---|---|---|
| Node.js | 22.23.1 | |
| pnpm | 12.15.0 | |
| git, gh | 2.53, 2.97 | |
| ffmpeg / ffprobe | 8.1.2 | on PATH |
| Docker | 29.6.2 | Docker Desktop must be running for SearXNG |
| Ollama | 0.40.16 | only `qwen3.5:4b` pulled |
| JDK | Temurin 17.0.21 | `C:\Users\ezher\scoop\apps\temurin17-jdk\current` (`JAVA_HOME` set) |
| Android SDK | cmdline-tools, platform-tools 37.0.1 (adb), platform `android-36`, build-tools 36.0.0; licences accepted | `C:\Users\ezher\scoop\apps\android-clt\current` (`ANDROID_HOME` set) |

JDK and Android SDK were installed with Scoop (`scoop install java/temurin17-jdk main/android-clt`), no admin rights needed. Open a **new** terminal to pick up `JAVA_HOME`, `ANDROID_HOME` and PATH. Gradle downloads the NDK and CMake on the first Android build (several GB, 15–30 minutes).

Android Studio is not installed and not required. There is no emulator: development uses the physical phone.

Not installed: Rust (only needed if a Tauri shell is ever chosen), Piper (installed by task T26), Tailscale (owner action below).

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

## Local profile (task T26)

- LLM: `ollama pull` a larger model if wanted. With 16 GB RAM and no GPU, expect models up to roughly 8B parameters at slow speed; fine for English drafts, not for graded Hungarian.
- Search: `docker compose -f infra/docker-compose.searxng.yml up -d`.
- TTS: Piper binary and voices are downloaded by `pnpm run piper:install`.

## Handing tasks to a coding agent

From the repo root, start the agent (Claude Code, Codex, OpenCode or similar) and say:

> Read AGENTS.md, then do the first unchecked task in tasks/todo.md.

One task per session. Review the diff and the task's Verify output before starting the next.
