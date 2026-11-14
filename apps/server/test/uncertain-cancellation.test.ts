import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { fakeGeneration } from "./generation-fakes.ts";

const secret = "synthetic-cancel-provider-credential";

test("cancelled in-flight provider retains cancellation, warning and guard", async () => {
  const f = fakeGeneration();
  const events = new EventEmitter();
  const received: unknown[] = [];
  events.on("event", (event) => received.push(event));
  let entered!: () => void;
  let rejectCall!: (error: Error) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.deps.providers.llm = { async generateObject() { entered(); return new Promise((_resolve, reject) => { rejectCall = reject; }); } };
  const runner = createDesktopRunner(f.deps, events);
  const app = buildApp({ db: f.db, runner, events });
  const request = { title: "Bees", brief: "", mode: "standard" as const, lang: "en", minutes: 1 };
  const warning = "Generation cancelled; external work may still be running; stop the server and follow manual recovery in SETUP.md";
  try {
    const job = await runner.create(request);
    await started;
    await runner.cancel(job.id);
    rejectCall(new DOMException(secret, "AbortError"));
    await vi.waitFor(async () => await expect(runner.create(request)).rejects.toThrow(/manual recovery/i));
    const response = await app.inject({ url: `/api/jobs/${job.id}` });
    expect(response.json()).toMatchObject({ status: "cancelled", error: warning, stages: expect.arrayContaining([expect.objectContaining({ stage: "plan", status: "failed", error: warning })]) });
    expect(received).toContainEqual(expect.objectContaining({ type: "job-stage", status: "failed", error: warning }));
    expect(JSON.stringify(received) + response.body).not.toContain(secret);
  } finally { await app.close(); await runner.close(); f.close(); }
});
