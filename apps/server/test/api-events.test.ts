import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

test("streams fake job stage and episode events to a connected client", async () => {
  const db = openDatabase(":memory:");
  const events = new EventEmitter();
  const event = { type: "job-stage", jobId: "fake-job", stage: "plan", status: "running" };
  const job = {
    id: "fake-job",
    topicId: null,
    status: "running",
    currentStage: "plan",
    error: null,
    options: { title: "News", brief: "", mode: "standard", lang: "en", minutes: 8 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  const runner = {
    create: async () => {
      events.emit("event", event);
      return job;
    },
    retry: async () => job,
    cancel: async () => job,
  };
  const app = buildApp({ db, events, runner });
  const controller = new AbortController();
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: job.options });
    expect(created.statusCode).toBe(201);
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain(`data: ${JSON.stringify(event)}\n\n`);
    const ready = { type: "episode-ready", jobId: "fake-job", episodeId: "episode" };
    events.emit("event", ready);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      `data: ${JSON.stringify(ready)}\n\n`,
    );
    await reader.cancel();
  } finally {
    controller.abort();
    await app.close();
    db.$client.close();
  }
});
