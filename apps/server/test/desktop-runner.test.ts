import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";
import { loadConfig } from "../src/config.ts";

test(
  "HTTP creates and runs a new job without starting an old queued job",
  async () => {
    const f = fakeGeneration();
    const events = new EventEmitter();
    const runner = createDesktopRunner(f.deps, events);
    const app = buildApp({ db: f.db, runner, events });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const stream = await fetch(`${address}/api/events`);
      const reader = stream.body!.getReader();
      const received: string[] = [];
      const readEvents = (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received.push(new TextDecoder().decode(chunk.value));
        }
      })();
      const response = await fetch(`${address}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Bees",
          brief: "",
          mode: "standard",
          lang: "en",
          minutes: 1,
          review: false,
        }),
      });
      expect(response.status).toBe(201);
      const job = (await response.json()) as { id: string };
      await viWait(
        async () =>
          ((await (await fetch(`${address}/api/jobs/${job.id}`)).json()) as { status: string })
            .status === "succeeded",
      );
      await viWait(async () => received.join("").includes('"episode-ready"'));
      expect(received.join("")).toContain('"job-stage"');
      expect(f.job().status).toBe("queued");
      expect(
        (
          await fetch(`${address}/api/jobs/${job.id}/retry`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(409);
      await reader.cancel();
      await readEvents;
    } finally {
      await app.close();
      await runner.close();
      f.close();
    }
  },
  GENERATION_TIMEOUT_MS,
);

test(
  "cancelled active work blocks the next job until the provider returns",
  async () => {
    const f = fakeGeneration();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const llm = f.deps.providers.llm;
    f.deps.providers.llm = {
      async generateObject(request) {
        entered();
        await gate;
        return llm.generateObject(request);
      },
    };
    const runner = createDesktopRunner(f.deps, new EventEmitter());
    const app = buildApp({ db: f.db, runner });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const create = async () =>
        (await (
          await fetch(`${address}/api/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "Bees",
              mode: "standard",
              lang: "en",
              minutes: 1,
              review: false,
            }),
          })
        ).json()) as { id: string };
      const first = await create();
      await started;
      const second = await create();
      expect(
        (await fetch(`${address}/api/jobs/${first.id}/cancel`, { method: "POST" })).status,
      ).toBe(200);
      expect(
        ((await (await fetch(`${address}/api/jobs/${second.id}`)).json()) as { status: string })
          .status,
      ).toBe("queued");
      release();
      await viWait(
        async () =>
          ((await (await fetch(`${address}/api/jobs/${second.id}`)).json()) as { status: string })
            .status === "succeeded",
      );
      expect(
        ((await (await fetch(`${address}/api/jobs/${first.id}`)).json()) as { status: string })
          .status,
      ).toBe("cancelled");
    } finally {
      release();
      await app.close();
      await runner.close();
      f.close();
    }
  },
  GENERATION_TIMEOUT_MS,
);

test("shutdown closes SSE and bounds a blocked local call", async () => {
  const f = fakeGeneration();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const llm = f.deps.providers.llm;
  f.deps.providers.llm = {
    async generateObject(request) {
      entered();
      await gate;
      return llm.generateObject(request);
    },
  };
  const events = new EventEmitter();
  const runner = createDesktopRunner(f.deps, events);
  const app = buildApp({ db: f.db, runner, events });
  let drained = true;
  app.addHook("onClose", async () => {
    drained = await runner.close();
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const stream = await fetch(`${address}/api/events`);
    const response = await fetch(`${address}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bees", mode: "standard", lang: "en", minutes: 1 }),
    });
    const job = (await response.json()) as { id: string };
    await started;
    await app.close();
    expect(drained).toBe(false);
    expect(events.listenerCount("event")).toBe(0);
    expect(f.job().status).toBe("queued");
    expect(f.db.$client.prepare("select status from jobs where id = ?").get(job.id)).toMatchObject({
      status: "cancelled",
    });
    await stream.body?.cancel();
  } finally {
    release();
    await viWait(async () => await runner.close());
    f.close();
  }
}, 15_000);

test("desktop runner refuses non-local provider settings before creating a job", async () => {
  const f = fakeGeneration();
  const config = loadConfig({
    rootDir: f.dir,
    env: { PROFILE: "local", SEARCH_PROVIDER: "tavily" },
  });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), config);
  try {
    await expect(
      runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 }),
    ).rejects.toThrow("requires local");
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 1 });
  } finally {
    await runner.close();
    f.close();
  }
});

async function viWait(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 60_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("job did not succeed");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
