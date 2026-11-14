import { webRoot } from "./paths.ts";
import { APP_NAME } from "shared";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ensureDataDirs } from "./data-dir.ts";
import { openDatabase } from "./db/index.ts";
import path from "node:path";
import { createChatGptSession } from "./providers/llm/chatgpt-session.ts";
import { EventEmitter } from "node:events";
import { createProviders } from "./providers/index.ts";
import { createDesktopRunner } from "./desktop-runner.ts";
import { createScriptSelection } from "./chatgpt-selection.ts";
import { installShutdown, registerRunnerShutdown } from "./shutdown.ts";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const dataDirs = ensureDataDirs(config.DATA_DIR);
const db = openDatabase(dataDirs.dbFile);
const chatgptSession = ["127.0.0.1", "::1"].includes(config.HOST)
  ? await createChatGptSession(path.join(config.DATA_DIR, "chatgpt"))
  : undefined;
const events = new EventEmitter();
const scriptSelection = createScriptSelection(path.join(config.DATA_DIR, "chatgpt"), chatgptSession);
const runner = config.PROFILE === "local" && config.SEARCH_PROVIDER === "searxng" && config.TTS_PROVIDER === "piper"
  ? createDesktopRunner({
      db, providers: createProviders(config), dataDir: dataDirs.root,
      budgetUsd: config.MONTHLY_BUDGET_USD, voice: config.TTS_VOICE_NATIVE_HOST ?? "",
      profile: "local", llmName: config.OLLAMA_MODEL_MAIN, ttsName: "piper", nativeLang: config.NATIVE_LANG,
    }, events, config, scriptSelection)
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
registerRunnerShutdown(app, db, runner);
await app.listen({ host: config.HOST, port: config.PORT });
installShutdown(app);
console.log(`${APP_NAME} server listening on http://${config.HOST}:${config.PORT}`);
