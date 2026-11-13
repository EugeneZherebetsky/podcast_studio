import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { fakeGeneration } from "./generation-fakes.ts";
import { parseConfig } from "shared";

test("queued jobs expose a safe snapshot of their captured model", async () => {
  const f = fakeGeneration();
  const events = new EventEmitter();
  const runner = createDesktopRunner(f.deps, events);
  const app = buildApp({ db: f.db, runner, events, config: parseConfig({ DATA_DIR: f.dir }) });
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false });
    const response = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/details` });
    expect(response.json().model).toBe("fake-main");
  } finally { await runner.close(); await app.close(); f.close(); }
});
