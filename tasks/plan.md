# Implementation plan

## Shape

Five milestones, each ending in something the owner can use and judge. Tasks are vertical where possible: after M1 there is already a real episode to listen to, before any UI exists.

| Milestone | Outcome the owner can check | Tasks |
|---|---|---|
| M0 Foundation | Repo installs, lints, tests | T01–T03 |
| M1 Walking skeleton | `pnpm gen "topic"` writes a real episode | T04–T12 |
| M2 Desktop | Create, schedule and play episodes in the browser app | T13–T16 |
| M3 Android core | One-way home Wi-Fi and manual USB episode import; offline background playback | T17–T19 |
| M4 Hungarian learning | Graded and bilingual episodes; transcript, drill, vocabulary | T20–T24 |
| M5 Adaptive and local | Automatic phone-vocabulary adaptation deferred; local-model profile | T25–T27 |

## Dependency graph

```
T01 → T02 → T03 → T04 ─┬→ T05 ─┐
                       ├→ T06 ─┼→ T08 → T09 ─┐
                       ├→ T07 ─┘             ├→ T12 → T13 ─┬→ T14
                       └→ T10 → T11 ─────────┘             ├→ T15 → T16
                                                           ├→ T17 ─┐
                                                           └→ T18 ─┴→ T19 (Wi-Fi)
                                                                └────→ T19 (USB)
T12 → T20 → T21            T19 + T20 → T22 → T23 → T24
T25 deferred pending separate owner decision
T12 → T26
```

Revised sequence: complete the first unchecked T12 (existing work is in another worktree), then finish T13–T16; T17 security design/approval and T18 device verification precede the T19 Wi-Fi path. T19 USB import can proceed independently after T18 foundations. Then T20–T24 and T26–T27; T25 is deferred. T13–T19 contain partial commits, not completed acceptance. Retain existing legacy sync code/data and ask first before shared, SQLite or package-format changes.

Parallelisable once T04 is merged: {T05, T06, T07, T10}. After T13: web (T15–T16) and mobile (T17–T19) tracks can run in parallel with different agents, because both depend only on `packages/shared` and the API.

## Checkpoints (owner decides go / change)

1. **After T12:** listen to two English episodes. Judge research quality, script style, voice. Cheapest moment to change prompts, providers or episode structure.
2. **After T16:** the desktop product is complete on its own.
3. **After T18:** background playback proven on the actual phone before investing in transfer and learning screens.
4. **After T19:** validate accepted-device home Wi-Fi download and independent USB import, integrity failures, and airplane-mode playback.
5. **After T20:** Hungarian correctness spot-check. If quality is not acceptable with the chosen model, change model or add the analyser cross-check before building the learning UI on top.

## Risks carried by specific tasks

- T10 / T20: Hungarian voice and text quality. Evaluate early with `pnpm smoke --only tts` on 10 Hungarian sentences.
- T11: timing accuracy. Everything in learning mode depends on it; do not relax the ±80 ms test.
- T18: Android background-playback rules and Expo SDK 58 APIs are newer than model training data; read docs first.
- T05: structured-output API names differ between AI SDK major versions; read docs first.

## What the owner must provide before M1 real runs

API keys in `.env` (see `.env.example`): one LLM provider, Tavily (or Brave), Azure Speech. Before T18: the phone with USB debugging on. See `docs/SETUP.md`.
