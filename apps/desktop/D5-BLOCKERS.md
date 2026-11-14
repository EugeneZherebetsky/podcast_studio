# D5 work in progress: key management is not enabled

The encrypted store is an isolated building block, not a complete feature. It is not imported by the desktop shell and must not be connected to real credentials yet.

Before enabling it:

- Coordinate child replacement with the generation guard. The D4 supervisor's `stop()` kills a child after a timeout, and the server has no atomic idle-and-restart operation. Checking idle and then stopping races a newly accepted job. Never use the current stop path to apply a key change while generation may be active or uncertain. A safe alternative is to defer all changes until a separately safe restart, clearly telling the user when they take effect.
- Prevent `.env` fallback in the desktop child and inject only the explicitly allowlisted decrypted names. `loadConfig` currently loads `<home>/.env`; blank/missing environment entries do not mask file values. Keep repository/browser behavior unchanged.
- Audit every error/persistence path before injecting secrets: the OpenAI TTS provider includes an upstream response body in thrown errors, and the pipeline persists raw messages in SQLite. Do not assume all provider errors are redacted. Verify synthetic secrets do not reach HTTP, events, logs, or persistent job records, including failure responses.
- Add a separate locked-down key-entry window, narrow preload API and validated sender; verify its UI and child environment in a real Electron app, using isolated test data and synthetic keys only. No ChatGPT session tokens belong in this store.
- Add write/rename failure injection and cross-process/symlink threat review before considering this store production-ready. Atomic rename preserves the old blob on failure; no durability guarantee after sudden power loss has been established. File permission bits alone do not establish Windows ACLs.

The store is Windows-only and fails closed when encryption is unavailable. Windows safeStorage uses DPAPI and does not protect against other programs running as the same user: https://www.electronjs.org/docs/latest/api/safe-storage#platform-specific-key-providers. Electron recommends isolated, sandboxed renderers and validating every IPC sender: https://www.electronjs.org/docs/latest/tutorial/security.

Tests: `node --test apps/desktop/secrets.test.mjs`. Manual synthetic DPAPI probe: `pnpm exec electron apps/desktop/secrets-electron-smoke.mjs`. The probe uses a fresh temporary profile and does not start the real server or UI.
