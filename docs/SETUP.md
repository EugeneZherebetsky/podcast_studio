# Setup

## Required tools

| Tool | Needed for |
|---|---|
| Node.js 22 or newer, pnpm (repository pins 12.15.0), Git | PC and project setup |
| ffmpeg / ffprobe on PATH | audio assembly |
| JDK 17 (`JAVA_HOME` set) | Android build |
| Android SDK and accepted licences (`ANDROID_HOME` set), including platform-tools (adb) | Android build; see the [mobile guide](../apps/mobile/README.md) for SDK requirements |
| Docker | SearXNG, local profile only |
| Ollama | local profile only |

Android builds may download additional native dependencies. See the [mobile guide](../apps/mobile/README.md) for build commands and device checks.

Android Studio and an emulator are not required: development uses a physical phone.

The state of the owner's own machine (paths, versions, hardware) is recorded in `docs/LOCAL.md`, which is git-ignored.

## PC configuration

Copy `.env.example` to `.env`. For the current PC runner set `PROFILE=local`, `SEARCH_PROVIDER=searxng`, `TTS_PROVIDER=piper`, and set `TTS_VOICE_NATIVE_HOST` and `TTS_VOICE_HU_HOST` to installed Piper voice names as needed. Choose `OLLAMA_MODEL_MAIN` and `OLLAMA_MODEL_FAST` and pull them in Ollama. Start Ollama and SearXNG and install Piper and its voices as described below. The Settings profile preference must also be local; it does not switch server providers. The current desktop runner accepts standard mode only, regardless of `ALLOW_LOCAL_LEARNING`.

The sample environment defaults to cloud, but those defaults do not enable the desktop runner. Anthropic, OpenAI, Tavily, Brave and Azure settings in the example relate to other provider paths; their presence does not make cloud-profile desktop generation available. ChatGPT subscription access is a separate explicit choice; see [ChatGPT plan](CHATGPT-PLAN.md).

Never paste keys into a chat with an agent; put them in `.env` yourself. Nonblank process environment variables override values in `.env`; restart after changes.

ChatGPT generation has a hard per-request deadline of 300 seconds for scripts and 120 seconds for other stages. To change these, set the server process environment variables `CHATGPT_SCRIPT_TIMEOUT_MS` and `CHATGPT_STAGE_TIMEOUT_MS` before starting it (these two overrides are not read from `.env`). Values must be integer milliseconds between 1000 and 900000. A timeout or cancellation does not prove remote generation stopped; do not automatically retry. Follow the manual recovery instructions below and leave the recovery marker in place if remote work cannot be confirmed stopped. The progress log reports only event and byte counts, not response content.

### Optional cloud speech

Desktop speech defaults to local Piper. To opt in to ElevenLabs or Fish Audio, obtain a provider API key, put `ELEVENLABS_API_KEY` or `FISH_AUDIO_API_KEY` in the ignored root `.env`, and restart the server. In Settings select the provider, a supported model, its voice ID (Fish voice reference ID), and an input limit, then save settings. Key presence does not test connectivity. Choose Piper to return to local speech. Real cloud TTS has not been verified against the providers.

The script is sent to that provider and billed separately; the input limit bounds total UTF-8 bytes and UTF-16 characters, not cost. Cloud speech is excluded from recorded usage, episode cost and the monthly budget; these are not total cost. New episode `generation.costUsd` records tracked LLM estimates only, excluding TTS and unmetered usage; older episodes may contain a hardcoded zero placeholder. Consult the provider's pricing and account controls. Requests are not automatically retried or cached; a failed, timed-out or cancelled request may still have been billed. Check the provider and follow manual recovery before resuming when the outcome is unclear. Supported request formats: https://elevenlabs.io/docs/api-reference/text-to-speech/convert and https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech.

### Phone development

1. Settings → About phone → tap **Build number** seven times.
2. Settings → Developer options → enable **USB debugging**.
3. Connect by USB, accept the prompt on the phone, then run `adb devices`: the phone must show as `device`.

### Network safety

Keep the default numeric loopback binding for PC use. Android pairing, Wi-Fi downloads and sync are not implemented. Plain HTTP exposes pairing codes and device tokens on the network, and HTTPS through a reverse proxy is not supported until its authentication boundary is designed. Do not expose the server to the LAN or Internet for phone transfer; use the manual USB workflow instead.

## Windows login autostart

After installing dependencies, `pnpm autostart:install` registers a Windows Task Scheduler login task for this checkout and current user; it does not start the server immediately or overwrite an existing task. `pnpm autostart:remove` removes it only if its action still matches this checkout and the current Node executable. If Node or the checkout moves, inspect the old task in Task Scheduler before removing it manually. Neither command deletes application data. The server requires its usual configuration and dependencies at login.

At login the launcher builds the web interface before starting the server; a build failure prevents startup rather than serving a stale build. Open `http://127.0.0.1:4747` (or the configured port) for the same-origin interface and ChatGPT Settings. After changing web code, restart the task to rebuild it. For manual production startup, run `pnpm --filter web build` before `pnpm --filter server start`. Browser installation and the login task still require manual verification.

## Local profile details

Local search and article retrieval still use the network; a local profile is not an offline guarantee. The PC runner supports standard mode only; `ALLOW_LOCAL_LEARNING` does not enable graded or bilingual desktop jobs.

- LLM: `ollama pull` the model named in `.env`. Cloud-named models are rejected, but names alone cannot verify custom Modelfiles or aliases, and a loopback proxy could forward prompts remotely. For a trusted Ollama server, disable its cloud features with `OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud` in server configuration and restart it; see [Ollama's local FAQ](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features). This does not control other services or network access. On a CPU-only machine expect small models at slow speed: fine for English drafts, not for graded Hungarian.

- Search: `docker compose -f infra/docker-compose.searxng.yml up -d`.
- TTS: the optional Piper provider expects Piper 1.8.0 in `PIPER_DIR/venv` and voice files in `PIPER_DIR/voices` (`PIPER_DIR` defaults to `infra/piper`). Install it in an isolated Python virtual environment with `python -m venv infra/piper/venv`, then use that environment's Python to run `-m pip install piper-tts==1.8.0`. Piper and its ONNX runtime dependencies include native code. The upstream maintained engine is [GPL-3.0-or-later](https://github.com/OHF-Voice/piper1-gpl/blob/v1.8.0/COPYING); review the license before installing or redistributing.
- Voice download is separate and explicit: after reviewing the restrictions below, run `node scripts/piper-voices.mjs --accept-licenses` from the repository root. Pass a directory after the flag if `PIPER_DIR` differs. The script downloads pinned English `en_US-lessac-medium` and Hungarian `hu_HU-anna-medium` model, config and model card files and verifies SHA-256 before writing. It refuses to overwrite existing files with different hashes. Configure the corresponding `TTS_VOICE_*` values in `.env`; do not leave the Azure voice defaults when using Piper. Other Piper voices can be placed in the voices directory as matching `.onnx` and `.onnx.json` pairs and selected by their filename without the extension.
- **Voice restrictions:** the English Lessac voice is trained on the [Lessac Blizzard 2013 corpus](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html), whose license limits use to research/exploration and excludes commercial synthesis. Anna's own dataset is CC0 but its card says it was fine-tuned from Lessac, so Lessac restrictions may also apply. The Piper project does not grant rights to voice weights; see its [voice licensing guidance](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/LICENSING.md) and the downloaded model cards. Do not assume these models are suitable for commercial use or redistribution.

## Desktop generation recovery

Stop every server and generation CLI before upgrading; older versions do not honor the new lock, so mixed versions are unsafe. The lock file `desktop-generation-lock.sqlite` and state file `desktop-generation-state.sqlite` are in `DATA_DIR`; never delete the lock file while any server or CLI may be running. The state file records work that may not have stopped. A crash, failed external call, or shutdown that cannot drain work may block generation. Old queued or running jobs remain visible and unresolved; they are not resumed or automatically marked interrupted. To recover, stop all servers and CLIs, independently verify that their Piper and ffmpeg children, any Ollama requests and any cloud-provider requests have finished (a missing PID alone is not proof), check the provider for possible billing, and inspect any unfinished publication and job data. Once you have established that no old worker can write or publish, manually remove only `desktop-generation-state.sqlite` and its SQLite journal files, then restart. Do not delete job or episode data as part of recovery. If you cannot establish quiescence, leave the state file in place and do not restart generation.

## Handing tasks to a coding agent

From the repo root, start the agent (Claude Code, Codex, OpenCode or similar) and say:

> Read AGENTS.md, then do the first unchecked task in tasks/todo.md.

One task per session. Review the diff and the task's Verify output before starting the next.
