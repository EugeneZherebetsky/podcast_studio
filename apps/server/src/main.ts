import { fileURLToPath } from "node:url";
import { APP_NAME } from "shared";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ensureDataDirs } from "./data-dir.ts";
import { openDatabase } from "./db/index.ts";
import path from "node:path";
import { createChatGptSession } from "./providers/llm/chatgpt-session.ts";

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

const app = buildApp({
  db,
  config,
  chatgptSession,
  webRoot: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
app.addHook("onClose", () => {
  db.$client.close();
});
await app.listen({ host: config.HOST, port: config.PORT });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
console.log(`${APP_NAME} server listening on http://${config.HOST}:${config.PORT}`);
