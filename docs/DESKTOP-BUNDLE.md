# Desktop server bundle (D2)

Build on the target OS and architecture with Node 22 and the installed workspace dependencies:

```text
pnpm install --frozen-lockfile
pnpm --filter web run build
pnpm desktop:bundle
```

`dist-desktop/` contains the built web app, `server/server.mjs`, migrations, prompts,
external runtime packages including the native SQLite binary, and a copy of the Node
executable used for the build. The builder opens SQLite with that Node before finishing;
keep this executable and its native addon together. Build separately per OS/architecture.
The output directory is generated and ignored by Git. The builder requires that
`dist-desktop/` does not exist, even if empty; it never overlays or deletes old output.
Before rebuilding, preserve or move the old directory to a safe location. A failed build
may leave a partial directory: preserve or move it too before retrying. Do not put user
data in the output directory.

Run the executable in `node/` with `server/server.mjs`. Set `PODCAST_STUDIO_RESOURCES`
to the absolute `dist-desktop` path, `PODCAST_STUDIO_HOME` to an application-owned
configuration directory, and `DATA_DIR` to a separate writable data directory. Set
`FFMPEG_PATH` and `FFPROBE_PATH` to installed executables if they are not on PATH.
The bundle does not include ffmpeg or ffprobe; installer distribution and third-party
licences remain D6 work.

The HTTP health endpoint currently returns 503 when provider health checks are not
configured, even when the app is serving requests. Do not interpret that response alone
as a failed startup; verify the listener, UI and database without changing that API.

The desktop generation guard remains unchanged. It uses a SQLite lock and a durable
dirty marker; after an unclean generation, new generation is blocked until the manual
recovery described in SETUP.md. The runner does not automatically resume or scan old
jobs. The original D3 interrupted-job auto-resume gate is **not met**: resume is disabled
because ownership and remote side effects cannot be safely recovered automatically.

A future supervisor can spawn the server with `PODCAST_STUDIO_PARENT_STDIN=1` and a
piped stdin. Closing that pipe requests shutdown, including on Windows; keep it open
for the entire child lifetime. Without that exact opt-in, stdin EOF has no effect on
repository runs. Closing Fastify starts generation cancellation and ChatGPT session shutdown
before waiting for in-flight HTTP requests; the database and exclusive desktop guard remain
held until the requests and generation have drained. The database closes before the guard
is released. Repeated shutdown requests share the same cleanup. The server allows up to
eight seconds overall before a nonzero forced exit. If generation fails to drain within
its existing two-second bound, it exits nonzero without clearing the guard's dirty marker.
A stalled HTTP request can still exhaust the overall deadline: the OS then releases the
process lock, but any existing generation dirty marker remains, blocking new generation
pending manual recovery. This marker tracks generation, not every HTTP mutation; an
interrupted episode deletion can require separate inspection of the database and files.
Unfinished revocation or external work may continue remotely and must not be assumed complete. The
supervisor should allow more than eight seconds plus scheduling margin
before resorting to termination. Exit success is not proof remote work stopped: cancelled
or failed provider work and ChatGPT revocation can remain uncertain. Preserve all data,
consult SETUP.md for manual recovery, and never automatically resume or bypass the guard.
The development Electron supervisor uses this opt-in channel; see DESKTOP-SHELL.md.

For offline verification only, the builder accepts `--test-output <absolute-file>`.
It writes a new file in an existing directory outside `dist-desktop` and all copied
production input trees, including their resolved links and runtime packages. Test-mode builds
can run on supported Node versions; production bundles still require Node 22. The main entry's provider factory is
replaced at build time by `apps/server/test/desktop-bundle-fakes.ts`. It does not alter
the production bundle and no environment switch can enable the fakes. Run that test
bundle with a copied resource tree, isolated configuration/data directories and network
access blocked; never distribute it. Generation still needs ffmpeg and ffprobe. After the
build, run `python scripts/verify-desktop-bundle.py` with Python 3 and those binaries on
PATH (or set `FFMPEG_PATH` and `FFPROBE_PATH`). The verifier copies the bundle into a
new temporary directory, starts production and separately injected test bundles under
copied Node with separate resource trees, checks UI assets, migrations, health semantics,
and a completed fake job. It validates episode metadata with the existing EpisodeSchema,
checks audio byte count and SHA-256, and compares its ffprobe duration to metadata (within
one second). It retains its isolated fixtures and prints their path.
The JavaScript network guard is a test safeguard, not an OS-level firewall.

Implementation references: [esbuild API](https://esbuild.github.io/api/#bundle),
[esbuild external packages](https://esbuild.github.io/api/#external), and
[Node native addons](https://nodejs.org/api/addons.html#loading-addons-using-require).
