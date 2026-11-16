# D6 installer prototype — not a release

This isolated, unsigned NSIS prototype is not D6 acceptance. Its distinct app ID,
product name and user-data name avoid colliding with existing desktop installations.
It packages the D2 server bundle, Node and web assets. D5 provider keys are an
explicit opt-in that is off by default (see [Desktop shell](DESKTOP-SHELL.md#provider-keys-opt-in));
that path has not been run from this packaged prototype, so do not rely on it here. No auto-update is included.
Start at login remains off unless explicitly enabled. Repository workflows are unchanged.

**Blocker:** ffmpeg and ffprobe are not bundled. Gyan's Windows essentials build is
GPLv3, but the exact corresponding source and notices for all statically linked
libraries have not been established; do not redistribute it on that basis. The
prototype is not a self-contained release. The upstream [FFmpeg legal guidance](https://ffmpeg.org/legal.html)
and [builder description](https://www.gyan.dev/ffmpeg/builds/) explain the needed
review. A verified binary, corresponding sources, notices and licensing review are
required before shipping.

On first launch, select separately obtained, trusted `ffmpeg.exe` and `ffprobe.exe`
in the native file dialogs. Cancelling quits the prototype. The app only checks the
file names and existence, not their authenticity or capabilities; the selected
programs will run with your user privileges. Supply a build supporting `loudnorm`,
AAC encoding and the `ipod` muxer. Its adjacent DLLs must remain in place. Locations
are stored in the prototype's local user-data directory without credentials. If files
are moved, selection is requested again. To change them, use the tray menu's **Select
FFmpeg and ffprobe**, then quit and reopen. No `.env`, PATH setting, installation or
automatic download is required. See [FFmpeg investigation](FFMPEG-BTBN-INVESTIGATION.md).

Use the tray menu **Configure local services** to set Ollama's OpenAI-compatible
`/v1` URL, one model for both model slots, and the SearXNG URL. HTTP endpoints
must use `localhost`, `127.0.0.1` or `[::1]` without credentials. Settings are
stored separately from Piper and FFmpeg locations, and apply only after finishing
jobs, quitting and reopening. No connection or installation is attempted by the
settings dialog. A loopback proxy or a cloud-backed model alias can forward data;
use trusted services and disable Ollama cloud features separately as described in
[SETUP.md](SETUP.md).

If service settings are invalid, startup shows the exact settings file location and
does not modify it. Back up that file, correct its JSON and values with a text editor,
then quit and reopen. For reference, its three fields are `ollama`, `model`, and
`searxng`, all strings. Query strings and fragments are not accepted in endpoint URLs.

Use **Set up Piper voices** to select an existing Piper executable and English and
Hungarian voice pairs. After reopening, the selected voices take precedence over web
Piper voice settings; those saved web values are not overwritten. If cloud TTS is
configured in web settings, it still takes precedence and can incur charges. Changes
made in the native chooser never restart the running server.

First-run data import is not implemented: never blindly copy a live SQLite database or
WAL. The installer is configured to retain user data on uninstall. No existing data is
migrated, altered or deleted. Install and uninstall behavior is not yet verified.
Use a disposable account and isolated destination to test; do not overwrite an existing
installation. No generation, credential entry or login-item testing was performed.

After following [DESKTOP-BUNDLE.md](DESKTOP-BUNDLE.md), run
`pnpm exec electron-builder --win nsis --x64 --publish never`. Preserve any existing
`dist-installer` output before building; this prototype configuration does not enforce
an empty destination. The package requires Node 22 native SQLite built for the copied
Node runtime. [NSIS options](https://www.electron.build/v26/docs/nsis/) and
[Electron packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
describe the upstream mechanisms. Node's bundled license and other third-party notices
still require inclusion and audit before distribution.
