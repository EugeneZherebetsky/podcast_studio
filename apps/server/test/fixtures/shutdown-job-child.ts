import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createDesktopRunner } from "../../src/desktop-runner.ts";
import { createFakeProviders } from "../../src/providers/index.ts";
import { installShutdown } from "../../src/shutdown.ts";

const dir = process.argv[2]!;
const db = openDatabase(path.join(dir, "app.db"));
const fake = createFakeProviders({ wavDir: path.join(dir, "wav") });
const providers = { ...fake, llm: { async generateObject() {
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
  console.log(`WORKER ${worker.pid}`);
  await once(worker, "exit");
  throw new Error("fake work ended without a result");
} } };
const events = new EventEmitter();
const runner = createDesktopRunner({ db, providers, dataDir: dir, budgetUsd: 20, voice: "fixture", profile: "local", llmName: "fake", ttsName: "fake", nativeLang: "en" }, events);
const app = buildApp({ db, runner, events });
app.addHook("onClose", async () => { if (await runner.close()) db.$client.close(); else process.exitCode = 1; });
await app.listen({ host: "127.0.0.1", port: 0 });
installShutdown(app);
await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
