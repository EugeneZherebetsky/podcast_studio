# D5 remains disabled

The isolated key-store prototype is not integrated. Do not inject stored keys or add a key-entry UI until the following have been resolved and tested end to end:

- Provider and adapter exceptions can still enter SQLite and job-stage events as raw messages, including in `runJobStage` and `desktop-runner`. CLI and shutdown paths may also print errors. Suppressing the OpenAI TTS HTTP response body alone does not secure other providers or transport exceptions. Audit all sinks and test synthetic credentials through real job API, events, logs, database and stdout/stderr, including thrown adapter errors.
- A key change must not race a newly queued or uncertain generation. The supervisor's timeout can kill the child, and there is no atomic admission freeze, drain and restart protocol. Fail closed or defer application until a separately safe restart.
- The prototype needs a sender-validated, sandboxed desktop-only key-entry window, Windows safeStorage verification, atomic non-destructive updates with write/rename failure injection, and cross-process and symlink review. Never store ChatGPT tokens. No plaintext keys may pass over HTTP.
- The desktop child now ignores its home `.env` entirely. Existing repository-mode servers still load `.env`, but packaged desktop users who previously supplied cloud keys there cannot use those keys until a secure key-management path exists. This avoids a silent fallback to unmanaged credentials; it does not migrate or delete existing files.

The prototype remains on its separate branch. No claim of credential safety, power-loss durability, or protection against other processes running as the same Windows user is made here.
