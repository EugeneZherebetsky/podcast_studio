# Podcast Studio

Name a topic, get a podcast. A home server researches the topic on the web, writes a script, synthesises speech and syncs the episode to an Android app, which also teaches Hungarian through graded and bilingual episodes.

Status: **design complete, no code yet.**

## Export an existing episode for USB

From the repository root, run `pnpm usb:export "<package-directory>" "<new-export-directory>"`. The source is an existing package directory containing `episode.json` and `audio.m4a` (normally `episodes/<id>` under the configured data directory); the destination must not exist and its parent must already exist. This command does not generate episodes or overwrite a destination. It validates the shared metadata schema and the copied audio's size and SHA-256 before writing the original metadata. A failed export can leave an incomplete destination; inspect it and use a new directory to retry.

Copy both exported files to the phone over USB, then use Library's import picker to select `episode.json` and `audio.m4a`. Only import packages from a trusted source; checksums detect corruption, not malicious replacement. Device transfer, offline playback and restart-position checks remain to be verified.

| Document | Purpose |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | What and why, scope, success criteria, open questions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, pipeline, data contracts, API |
| [docs/LEARNING-MODE.md](docs/LEARNING-MODE.md) | Hungarian learning design |
| [docs/SETUP.md](docs/SETUP.md) | Installed tools, what the owner must do |
| [tasks/plan.md](tasks/plan.md) | Milestones, dependencies, checkpoints |
| [tasks/todo.md](tasks/todo.md) | 27 ordered tasks for coding agents |
| [AGENTS.md](AGENTS.md) | Rules for coding agents |
