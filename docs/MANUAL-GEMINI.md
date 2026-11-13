# Manual Gemini draft (isolated first slice)

Only standard, queued or failed jobs without a listed episode are eligible. This legacy workflow reads canonical research and refuses jobs with a `runs` directory; it does not support new run-specific artifacts. Before using a failed job, **verify that every earlier executor for it has stopped**; database ownership cannot fence its filesystem writes. Do not use this workflow while any old executor might write to the job or publish its episode. Recovery and retry remain disabled.

Preparation requires existing `data/jobs/JOB_ID/plan.json`, `notes.json` and `sources.json` (under the configured `DATA_DIR`). A newly queued job will not have these until research artifacts have been provided. These files are structurally validated, not proven to have been produced by the job or checked for factual truth; inspect their provenance. The workflow makes no provider calls and does not produce research. It temporarily claims the job for each command, and restores its prior state on completion; it does not hold the claim while you use Gemini. If a command dies while holding a claim, follow the existing interruption safety rules only after confirming its process is dead.

From the repository root:

```sh
pnpm --filter server manual-draft prepare JOB_ID
pnpm --filter server manual-draft import JOB_ID "PREPARATION_DIR" "RESPONSE_JSON"
```

Replace the placeholders with the job ID, the preparation directory printed by the first command, and the path to a UTF-8 file containing Gemini's JSON response. Review the warning in `prompt.txt` before sharing: the prompt includes the research notes and plan and will send them to the external service. No data is sent by these commands. Gemini may have its own costs and privacy terms.

Import rejects malformed, oversized, structurally invalid, wrong-language, out-of-budget or incorrectly cited responses, and refuses a preparation if the research changed. It writes an atomic `script.json` in a new run-specific directory and prints the path. It does not overwrite existing stage artifacts or update stage completion. Validation does **not** establish factual correctness or approve publication: the draft still needs the review stage. **There is currently no safe path from this isolated draft to review, audio or publication.** Do not copy it into the live pipeline: downstream files and publication are not fenced against stale executors. Supporting that handoff requires run-isolated downstream artifacts and ownership-fenced publication, followed by explicit integration with review and stage state.
