import { fileURLToPath } from "node:url";
import { APP_NAME } from "shared";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ensureDataDirs } from "./data-dir.ts";
import { openDatabase } from "./db/index.ts";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const dataDirs = ensureDataDirs(config.DATA_DIR);
const db = openDatabase(dataDirs.dbFile);

const app = buildApp({
  db,
  config,
  webRoot: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
app.addHook("onClose", () => {
  db.$client.close();
});
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`${APP_NAME} server listening on http://${config.HOST}:${config.PORT}`);
