# Desktop shell (D4 development)

The owner permitted D4 development before the T12 and T16 acceptance gates. Those
checks remain open. This is a development shell, not an installer or a claim of
end-to-end generation. D5 secret entry and D6 installer/first-run work are not
implemented. The repository workflow remains supported.

Build with the prerequisites and commands in [DESKTOP-BUNDLE.md](DESKTOP-BUNDLE.md),
then run `pnpm desktop:dev`. Electron 45's binary is downloaded on first use; its
installer can also be run explicitly with `pnpm exec install-electron`. The shell
uses a separate Electron user-data directory, not repository data. No credentials
are copied from the parent environment. Configuring providers and safe key storage
are not yet provided; do not put keys in the shell or expect paid features to work.
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
key management, restart controls, and release hardening remain future work.

References: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security),
[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window),
[webContents](https://www.electronjs.org/docs/latest/api/web-contents),
[app](https://www.electronjs.org/docs/latest/api/app), and
[session](https://www.electronjs.org/docs/latest/api/session).
