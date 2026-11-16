# D5: desktop provider keys (opt-in activation)

Status: implemented and covered by automated tests with synthetic values only. **No real
provider has been called, no real key has been used, and neither the Electron shell nor a
packaged installer build has been run with this change.** Treat first real use as a test.

## What it does

- The tray item **Provider keys** opens a sandboxed window backed by the Windows-only
  encrypted store (`provider-keys.bin`, Electron `safeStorage`/DPAPI). The window can list
  which keys are present, set or clear a key, and edit the activation choice. It has no call
  that returns a stored value.
- Activation is off by default and is stored separately in `key-activation.json` (a master
  switch plus the ticked key names; it never contains a key). A missing, unreadable or
  invalid file means off, so keys stored by the earlier inactive prototype do not become
  active by upgrading. Both the switch and at least one ticked key are required.
- At launch, and only then, the main process reads the ticked keys and adds them to the
  environment of the server child it spawns. With activation off the store is not opened.
- Nothing in the key window touches the running server. Saving, clearing, ticking and the
  master switch only change files; they apply after the user quits and reopens the app. A
  key already given to a running server stays in use until that server exits.

## Which keys reach the child, and why only these

The child always runs the local generation profile (`PROFILE=local`, SearXNG, Piper), and
the server refuses desktop generation otherwise. Inside that profile the generation runner
has exactly one keyed cloud path: **cloud speech**, ElevenLabs or Fish Audio, chosen in the
web Settings and saved in the child's database. So only `ELEVENLABS_API_KEY` and
`FISH_AUDIO_API_KEY` can be activated.

The other six names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
`TAVILY_API_KEY`, `BRAVE_API_KEY`, `AZURE_SPEECH_KEY`) can be stored but are never passed.
This is not a desktop restriction: the generation runner and `pnpm gen` refuse every
non-local LLM, search and speech configuration, with or without a `.env`, because paid LLM
and search use is not yet priced and bounded there (no price table entries, no model ids,
no request deadline or cancellation for cloud LLM calls). Passing those keys would expose
them to the child for no benefit. Enabling those providers is separate work on the server
runner, not on key handling.

Because the provider choice lives in the child's database, the shell cannot know which of
the two speech keys is needed. The per-key tick is therefore the minimisation: the user
passes only the key for the provider they selected. Activation never changes saved Settings.

## Transport and handling

- Transport is the child's environment at spawn. Keys are never placed in command-line
  arguments, files, logs, the renderer, or the child's stdout/stderr (both are discarded by
  the shell). The child environment is built from an allowlist; nothing else from the
  parent environment is copied, including base-URL, proxy, `NODE_OPTIONS` and CA overrides.
- A stored value that is not printable ASCII without spaces is withheld (it could not be a
  safe HTTP header value) and the launch is reported as partial.
- If the store cannot be read (corrupt, locked, encryption unavailable) the app starts
  without keys. The tray tooltip and the key window show a fixed sentence; no error detail
  is shown or logged.
- After the child has parsed its configuration it deletes all provider key variables from
  its own environment, so the Piper and ffmpeg programs it starts do not inherit them.
- Credential-bearing requests go only to fixed HTTPS endpoints. The cloud speech endpoints
  are constants, redirects are refused, and the voice id that forms part of the ElevenLabs
  path is restricted to `[A-Za-z0-9_-]`. The audit also closed two override routes in
  providers the desktop child does not use: the AI SDK clients now receive their built-in
  base URL explicitly (they otherwise honour `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`), and
  the Azure Speech region, which forms the request host, must match `[a-z0-9]{1,40}`.
  Tavily, Brave and OpenAI speech take no endpoint from configuration.

## The former blockers

| Gate | State |
| --- | --- |
| Fixed HTTPS endpoints for every credential-bearing request | Resolved for the activatable providers; override routes closed and tested for the others (`endpoint-pinning.test.ts`, `desktop-key-containment.test.ts`). |
| Secret-free errors across success, error, timeout and cancellation through the real dispatch path, inspecting SQLite, artifacts, events, HTTP and SSE | Resolved for cloud speech with a mock transport (`desktop-key-containment.test.ts`: both providers; success, HTTP 401, network failure, timeout, cancellation). A real spawned child is checked for output, storage and HTTP replies at startup (`desktop-child-keys.test.ts`). CLI output was not re-examined: the desktop app does not run the CLI. |
| Scanner read properties through getters and returned the original object | Resolved: the guard returns a plain snapshot built from the values it scanned, each read once; anything that is not plain data is blocked (`credential-echo-snapshot.test.ts`). |
| A blocked paid LLM result could lose its usage record | Resolved: valid usage is recorded with provider and model reduced to known labels; usage that is present but not trustworthy is recorded as unreconciled spend, which stops the budget guard until reconciled. |
| A key change must not restart or interrupt a job; activation only at the next manual launch | Resolved by construction and tested: one read per launch, no server handle in the key window code. The window tells the user to finish jobs first. The app does **not** verify that no job is active before the user quits; quitting stops generation as it always has. |
| Store locking, corruption handling, durability | Unchanged. A stale lock left by a crash now also means the next launch starts without keys (after a short wait) until the lock is recovered manually. Do not remove stale locks automatically. Power-loss durability is not established. |
| Window exposes only presence/set/clear | Now presence, set, clear and the activation choice. Still no read call (tested). Never store ChatGPT session tokens: the allowlist is unchanged. |
| Electron file-protocol guidance, session permissions, packaged integrity | **Not reviewed.** Open. |
| Symlink test needs privileges; installed packaging and the real shell with a separate profile | **Not done.** The symlink test is skipped where the privilege is missing. `write-only-smoke.mjs` (an Electron probe) and the packaged installer were not run with this change. Open. |

## Accepted residual risk

- Any program running as the same Windows user can read the app's memory, the child's
  startup environment and the DPAPI-protected store, and can edit `key-activation.json`.
  This design does not defend against that; the owner accepted it.
- A selected provider necessarily receives its key and must be trusted. Speech audio and
  files a provider writes are not inspected. The result scanner matches exact and common
  encoded forms only; it is defense in depth, not the boundary.
- Cloud speech is billed by the provider and is not counted in recorded usage, episode cost
  or the monthly budget. A failed, timed-out or cancelled request may still have been
  billed; requests are never retried automatically.

## Not verified

- Any real provider call, real key, or live cloud speech result.
- The Electron shell itself: tray label, key window rendering and behaviour, `safeStorage`
  with real DPAPI, and the launch sequence in `main.mjs` (covered only by source-level and
  injected-fake tests).
- The packaged installer path (`electron-builder.yml` lists the two new modules; no build
  was made).
