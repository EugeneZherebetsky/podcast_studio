# Desktop shell (D4 development)

The owner permitted D4 development before the T12 and T16 acceptance gates. Those
checks remain open. This is a development shell, not an installer or a claim of
end-to-end generation. D6 installer/first-run work is not implemented. D5 provider
keys are implemented as an opt-in (see below) but have only been exercised by
automated tests with synthetic values. The repository workflow remains supported.

Build with the prerequisites and commands in [DESKTOP-BUNDLE.md](DESKTOP-BUNDLE.md),
then run `pnpm desktop:dev`. Electron 45's binary is downloaded on first use; its
installer can also be run explicitly with `pnpm exec install-electron`. The shell
uses a separate Electron user-data directory, not repository data. No credentials
are copied from the parent environment, and the child ignores any `.env`.

### Provider keys (opt-in)

The tray's **Provider keys** window stores keys encrypted for the current Windows
account and lets you choose which to use. Nothing is used until you switch
activation on and tick a key; keys saved by earlier builds stay inactive until you
do. The only keys the desktop server can use are `ELEVENLABS_API_KEY` and
`FISH_AUDIO_API_KEY`, for the cloud speech provider you select in the web Settings
(see [Setup: optional cloud speech](SETUP.md#optional-cloud-speech)). Keys for LLM,
search, Azure and OpenAI speech can be stored but are never given to the server,
because the generation runner refuses those providers; that is a server limitation,
with or without a `.env`.

Ticked keys are read once, when the app starts, and passed to the server child in
its environment. Saving, clearing or ticking a key never restarts or interrupts the
running server: **finish any jobs, then quit and reopen Podcast Studio** for a
change to apply. Clearing a key does not take it away from a server that is already
running. If the store cannot be read at launch, the app starts without keys and says
so in the tray tooltip and the key window.

Limits you should know: any program running under the same Windows account can read
this app's memory, the server's startup environment and the encrypted store, so it
can obtain an active key. Cloud speech is billed by the provider and is not counted
in the monthly budget. No real provider has been called with this feature, and it
has not been run in the Electron shell or from a packaged installer; details, the
endpoint and containment checks, and what remains open are in
[apps/desktop/D5-KEY-ACTIVATION.md](../apps/desktop/D5-KEY-ACTIVATION.md).

The tray's Piper setup selects an existing trusted Piper `venv` executable and English
and Hungarian ONNX voices in its `voices` directory, with matching `.onnx.json`
files. No engine or voice is included; review their licenses. Settings take effect
on the next launch; finish jobs before quitting. The picker checks file layout, not
the integrity or functionality of the engine or models. This does not enable the
still-blocked desktop generation runner.
Run `pnpm desktop:test-bundle` after creating `dist-desktop` to exercise the actual
bundled Node and server against an isolated data directory.

The child binds an OS-selected loopback port itself and reports it over its private
Node IPC channel only after Fastify listens and the shutdown handler is installed.
The shell never treats `/api/health` or arbitrary HTML as proof of startup. It closes
its window on child exit and does not restart automatically. This is startup
attestation, not a same-user OS security boundary: another program running as the
same account may interfere, and there is a small port-reuse race around child exit.
Do not use this as an authentication mechanism for hostile local users.

The main window is sandboxed, has context isolation, no Node integration or preload,
and denies permission requests/checks and webviews. Navigations and redirects are
restricted to the selected origin. Eligible external HTTPS links require confirmation
and open in the system browser. Window close hides it; the tray opens or quits it.
A second launch reopens the first window. Autostart is off unless explicitly enabled
in a packaged build; the toggle is disabled during development to avoid changing the
host login configuration. A packaged build and its login toggle have not been verified.

Quit or failed startup closes child stdin and allows eleven seconds for shutdown,
then requests termination and waits at most two more seconds for exit. If exit cannot
be confirmed, the shell warns that the server may still be running; do not start
another until it is independently stopped. A successful kill request is not proof
of exit. No automatic restart is attempted: an abnormal exit may leave work or
publication unresolved, so the planned retry policy is unsafe without stronger
quiescence guarantees. See [Node's process termination documentation](https://nodejs.org/api/child_process.html#subprocesskillsignal).
An abnormal shutdown may require the manual recovery described in SETUP.md. Neither
a clean exit nor this shell proves remote work or revocation completed; never bypass
the existing durable guard or automatically resume uncertain work. Windows shutdown
may terminate processes without a normal Electron quit event. Preserve all data.
Server output is currently discarded rather than written to unredacted logs, so errors
are generic. The tray uses a temporary generated icon; installer assets, logging,
restart controls, and release hardening remain future work.

References: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security),
[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window),
[webContents](https://www.electronjs.org/docs/latest/api/web-contents),
[app](https://www.electronjs.org/docs/latest/api/app), and
[session](https://www.electronjs.org/docs/latest/api/session).
