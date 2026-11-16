import { webRoot } from "./paths.ts";
import { APP_NAME } from "shared";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { dropDesktopProviderKeys } from "./desktop-env.ts";
import { ensureDataDirs } from "./data-dir.ts";
import { openDatabase } from "./db/index.ts";
import path from "node:path";
import { createChatGptSession } from "./providers/llm/chatgpt-session.ts";
import { EventEmitter } from "node:events";
import { createProviders } from "./providers/index.ts";
import { createDesktopRunner } from "./desktop-runner.ts";
import { openDesktopGuard } from "./desktop-guard.ts";
import { createScriptSelection } from "./chatgpt-selection.ts";
import { installShutdown, registerRunnerShutdown } from "./shutdown.ts";

let config;
try {
  config = loadConfig();
} catch {
  console.error("Server configuration could not be loaded; check configuration and permissions");
  process.exit(1);
}
dropDesktopProviderKeys();

if (!["127.0.0.1", "::1"].includes(config.HOST)) {
  console.error("Server requires a numeric loopback host (127.0.0.1 or ::1)");
  process.exit(1);
}

const desktopIpc = process.env.PODCAST_STUDIO_DESKTOP_IPC === "1" && typeof process.send === "function";
if (desktopIpc && !(config.PROFILE === "local" && config.SEARCH_PROVIDER === "searxng" && config.TTS_PROVIDER === "piper")) {
  throw new Error("Desktop server requires the local generation ownership guard");
}
const dataDirs = ensureDataDirs(config.DATA_DIR);
const desktopGuard = config.PROFILE === "local" && config.SEARCH_PROVIDER === "searxng" && config.TTS_PROVIDER === "piper"
  ? openDesktopGuard(dataDirs.root)
  : undefined;
const db = openDatabase(dataDirs.dbFile);
const chatgptSession = ["127.0.0.1", "::1"].includes(config.HOST)
  ? await createChatGptSession(path.join(config.DATA_DIR, "chatgpt"))
  : undefined;
const events = new EventEmitter();
const scriptSelection = createScriptSelection(path.join(config.DATA_DIR, "chatgpt"), chatgptSession);
const runner = desktopGuard
  ? createDesktopRunner({
      db, providers: createProviders(config), dataDir: dataDirs.root,
      budgetUsd: config.MONTHLY_BUDGET_USD, voice: config.TTS_VOICE_NATIVE_HOST ?? "",
      profile: "local", llmName: config.OLLAMA_MODEL_MAIN, ttsName: "piper", nativeLang: config.NATIVE_LANG,
    }, events, config, scriptSelection, desktopGuard, desktopIpc && process.env.PODCAST_STUDIO_NATIVE_PIPER === "1")
  : undefined;

const app = buildApp({
  db,
  config,
  runner,
  events,
  chatgptSession,
  scriptSelection,
  webRoot: webRoot(),
});
registerRunnerShutdown(app, db, runner, chatgptSession);
await app.listen({ host: config.HOST, port: desktopIpc ? 0 : config.PORT });
installShutdown(app);
const address = app.server.address();
if (desktopIpc && address && typeof address !== "string") {
  process.send?.({ type: "desktop-ready", port: address.port });
}
console.log(`${APP_NAME} server listening on http://${config.HOST}:${address && typeof address !== "string" ? address.port : config.PORT}`);
