import { EventEmitter } from "node:events";
import path from "node:path";
import { buildApp } from "../../src/app.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createDesktopRunner } from "../../src/desktop-runner.ts";
import { createFakeProviders } from "../../src/providers/index.ts";
import { installShutdown, registerRunnerShutdown } from "../../src/shutdown.ts";
import { CancelledAfterStage } from "../../src/pipeline/cancellation.ts";

const dir = process.argv[2]!;
const db = openDatabase(path.join(dir, "app.db"));
const events = new EventEmitter();
const fake = createFakeProviders({ wavDir: path.join(dir, "wav") });
const runner = createDesktopRunner({ db, providers: { ...fake, llm: { async generateObject() { throw new CancelledAfterStage("fixture stopped"); } } }, dataDir: dir, budgetUsd: 20, voice: "fixture", profile: "local", llmName: "fake", ttsName: "fake", nativeLang: "en" }, events);
const app = buildApp({ db, runner, events });
app.get("/stalled", async () => { console.log("STALLED"); await new Promise(() => {}); });
registerRunnerShutdown(app, db, runner);
const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
await new Promise<void>((resolve) => {
  const timer = setInterval(() => { if (!runner.isBusy!(job.id)) { clearInterval(timer); resolve(); } }, 10);
});
await app.listen({ host: "127.0.0.1", port: 0 });
installShutdown(app);
console.log(`READY ${(app.server.address() as { port: number }).port}`);
