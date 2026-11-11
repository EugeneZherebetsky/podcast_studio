# Implementation plan

## Shape

Five milestones, each ending in something the owner can use and judge. Tasks are vertical where possible: after M1 there is already a real episode to listen to, before any UI exists.

| Milestone | Outcome the owner can check | Tasks |
|---|---|---|
| M0 Foundation | Repo installs, lints, tests | T01–T03 |
| M1 Walking skeleton | `pnpm gen "topic"` writes a real episode | T04–T12 |
| M2 Desktop | Create, schedule and play episodes in the browser app | T13–T16 |
| M3 Android core | Episodes sync to the phone and play offline in the background | T17–T19 |
| M4 Hungarian learning | Graded and bilingual episodes; transcript, drill, vocabulary | T20–T24 |
| M5 Adaptive and local | Episodes reuse the learner's words; local-model profile | T25–T27 |

## Dependency graph

```
T01 → T02 → T03 → T04 ─┬→ T05 ─┐
                       ├→ T06 ─┼→ T08 → T09 ─┐
                       ├→ T07 ─┘             ├→ T12 → T13 ─┬→ T14
                       └→ T10 → T11 ─────────┘             ├→ T15 → T16
                                                           └→ T17 → T18 → T19
T12 → T20 → T21            T19 + T20 → T22 → T23 → T24 → T25
T12 → T26
```

Parallelisable once T04 is merged: {T05, T06, T07, T10}. After T13: web (T15–T16) and mobile (T17–T19) tracks can run in parallel with different agents, because both depend only on `packages/shared` and the API.

## Checkpoints (owner decides go / change)

1. **After T12:** listen to two English episodes. Judge research quality, script style, voice. Cheapest moment to change prompts, providers or episode structure.
2. **After T16:** the desktop product is complete on its own.
3. **After T18:** background playback proven on the actual phone before investing in sync and learning screens.
4. **After T20:** Hungarian correctness spot-check. If quality is not acceptable with the chosen model, change model or add the analyser cross-check before building the learning UI on top.

## Risks carried by specific tasks

- T10 / T20: Hungarian voice and text quality. Evaluate early with `pnpm smoke --only tts` on 10 Hungarian sentences.
- T11: timing accuracy. Everything in learning mode depends on it; do not relax the ±80 ms test.
- T18: Android background-playback rules and Expo SDK 58 APIs are newer than model training data; read docs first.
- T05: structured-output API names differ between AI SDK major versions; read docs first.

## What the owner must provide before M1 real runs

API keys in `.env` (see `.env.example`): one LLM provider, Tavily (or Brave), Azure Speech. Before T18: the phone with USB debugging on. See `docs/SETUP.md`.
