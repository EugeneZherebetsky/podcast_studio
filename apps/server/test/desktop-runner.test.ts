import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";
import { loadConfig } from "../src/config.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";

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
    expect(() => openDesktopGuard(f.dir)).toThrow(/another/i);
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

test("cancellation stops additional search queries", async () => {
  const f = fakeGeneration();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const search = f.deps.providers.search;
  f.deps.providers.search = { async search(query, options) {
    calls++;
    entered();
    await gate;
    return search.search(query, options);
  } };
  const runner = createDesktopRunner(f.deps, new EventEmitter());
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
    await started;
    await runner.cancel(job.id);
    release();
    await viWait(async () => (await runner.close()));
    expect(calls).toBe(1);
  } finally {
    release();
    await runner.close();
    f.close();
  }
}, GENERATION_TIMEOUT_MS);


test("a failed provider leaves recovery blocked even after the runner closes", async () => {
  const f = fakeGeneration();
  f.deps.providers.llm = { async generateObject() { throw new Error("connection lost"); } };
  const runner = createDesktopRunner(f.deps, new EventEmitter());
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
    await viWait(async () => (f.db.$client.prepare("select status from jobs where id = ?").get(job.id) as { status: string }).status === "failed");
    expect(await runner.close()).toBe(true);
    const guard = openDesktopGuard(f.dir);
    try { expect(() => guard.begin()).toThrow(/manual/i); }
    finally { guard.close(false); }
  } finally {
    await runner.close();
    f.close();
  }
});

test("does not announce a running stage when its database transition fails", async () => {
  const f = fakeGeneration();
  const events = new EventEmitter();
  const received: unknown[] = [];
  events.on("event", (event) => received.push(event));
  const runner = createDesktopRunner(f.deps, events);
  try {
    f.db.$client.exec("CREATE TRIGGER reject_stage BEFORE UPDATE ON job_stages BEGIN SELECT RAISE(ABORT, 'stage rejected'); END");
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
    await viWait(async () => (f.db.$client.prepare("select status from jobs where id = ?").get(job.id) as { status: string }).status === "failed");
    expect(received).not.toContainEqual(expect.objectContaining({ type: "job-stage", status: "running" }));
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
