# D6 installer prototype — not a release

This isolated, unsigned NSIS prototype is not D6 acceptance. Its distinct app ID,
product name and user-data name avoid colliding with existing desktop installations.
It packages the D2 server bundle, Node and web assets. D5 key management is disabled;
cloud credentials and paid provider calls must not be used. No auto-update is included.
Start at login remains off unless explicitly enabled. Repository workflows are unchanged.

**Blocker:** ffmpeg and ffprobe are not bundled. Gyan's Windows essentials build is
GPLv3, but the exact corresponding source and notices for all statically linked
libraries have not been established; do not redistribute it on that basis. The
prototype is not a self-contained release. The upstream [FFmpeg legal guidance](https://ffmpeg.org/legal.html)
and [builder description](https://www.gyan.dev/ffmpeg/builds/) explain the needed
review. A verified binary, corresponding sources, notices and licensing review are
required before shipping.

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
