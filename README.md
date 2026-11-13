# Podcast Studio

Podcast Studio is a work-in-progress PC episode generator and Android offline player. The PC researches a topic, drafts a script and produces an audio package for manual USB transfer to Android. Hungarian learning modes are part of the design; the current PC runner accepts **standard mode only**.

## Get started on the PC

1. Install the prerequisites, copy `.env.example` to `.env`, and configure the local generation profile, Ollama, SearXNG and Piper as described in [Setup](docs/SETUP.md). Keep `.env` and the data directory private.
2. From the repository root, run `pnpm install --frozen-lockfile`, then `pnpm --filter web build` and `pnpm --filter server start`.
3. Open `http://127.0.0.1:4747` on the PC. In Settings choose the local profile and configure a Piper voice, then create a standard episode. Jobs show progress and details; retry as a new job runs the stages again.
4. Optionally select a ChatGPT subscription for text stages or ElevenLabs/Fish Audio for speech. Both require explicit selection; see [ChatGPT plan](docs/CHATGPT-PLAN.md) and [cloud speech](docs/SETUP.md#optional-cloud-speech). Live provider operation has not been verified.

The server defaults to loopback. Local search and article fetching use the network; local generation is not a guarantee of offline operation. Do not expose the server to the LAN or Internet as a substitute for secure phone transfer: Wi-Fi transfer is not implemented and plain HTTP exposes credentials. See [network safety](docs/SETUP.md#network-safety).

## Current boundaries

- The PC runner requires local Ollama, SearXNG and Piper configuration, with explicit optional ChatGPT text generation and cloud speech. The saved profile preference alone does not switch server providers.
- ChatGPT sign-in and inference and real ElevenLabs/Fish Audio speech have not been verified live. Cloud speech is billed separately. Recorded usage, episode cost and the monthly budget exclude cloud TTS and ChatGPT subscription usage; they are **not total cost**.
- Android Wi-Fi pairing, downloads and sync are not implemented. Gemini is an isolated manual draft workflow, not a connected episode generator. Release signing and physical-device acceptance remain open; see the [Android guide](apps/mobile/README.md) and [manual Gemini guide](docs/MANUAL-GEMINI.md).
- A crash or uncertain external request can block further generation. Do not automatically retry; follow the [recovery procedure](docs/SETUP.md#desktop-generation-recovery).

## Export an existing episode for USB

In the PC Library, open a finished episode and use **Export for Android via USB**. Download both files into a new empty folder, retaining the names `episode.json` and `audio.m4a`. If the browser saves them elsewhere, move them to that folder; do not overwrite files from another episode. Connect and unlock the phone, select USB file transfer, copy the folder to the phone, and in Android Library choose **Import USB package**, then select the metadata and audio files in order. This is a manual transfer, not automatic sync. The browser downloads validate the package before serving each file; a failed validation returns an error instead of a download.

From the repository root, run `pnpm usb:export "<package-directory>" "<new-export-directory>"`. The source is an existing package directory containing `episode.json` and `audio.m4a` (normally `episodes/<id>` under the configured data directory); the destination must not exist and its parent must already exist. This command does not generate episodes or overwrite a destination. It validates the shared metadata schema and the copied audio's size and SHA-256 before writing the original metadata. A failed export can leave an incomplete destination; inspect it and use a new directory to retry.

Copy both exported files to the phone over USB, then use Library's import picker to select `episode.json` and `audio.m4a`. Only import packages from a trusted source; checksums detect corruption, not malicious replacement. Device transfer, offline playback and restart-position checks remain to be verified.

| Document | Purpose |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | What and why, scope, success criteria, open questions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components and design; includes planned behavior |
| [docs/LEARNING-MODE.md](docs/LEARNING-MODE.md) | Hungarian learning design |
| [docs/SETUP.md](docs/SETUP.md) | Prerequisites, configuration and recovery |
| [tasks/plan.md](tasks/plan.md) | Milestones, dependencies, checkpoints |
| [tasks/todo.md](tasks/todo.md) | 27 ordered tasks for coding agents |
| [AGENTS.md](AGENTS.md) | Rules for coding agents |
