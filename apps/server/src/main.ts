import { fileURLToPath } from "node:url";
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
const runner = config.PROFILE === "local" && config.SEARCH_PROVIDER === "searxng" && config.TTS_PROVIDER === "piper"
  ? createDesktopRunner({
      db, providers: createProviders(config), dataDir: dataDirs.root,
      budgetUsd: config.MONTHLY_BUDGET_USD, voice: config.TTS_VOICE_NATIVE_HOST ?? "",
      profile: "local", llmName: config.OLLAMA_MODEL_MAIN, ttsName: "piper", nativeLang: config.NATIVE_LANG,
    }, events, config)
  : undefined;

const app = buildApp({
  db,
  config,
  runner,
  events,
  chatgptSession,
  webRoot: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
app.addHook("onClose", async () => {
  if (!runner || await runner.close()) db.$client.close();
});
await app.listen({ host: config.HOST, port: config.PORT });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().finally(() => process.exit()); });
console.log(`${APP_NAME} server listening on http://${config.HOST}:${config.PORT}`);
