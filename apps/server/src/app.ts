import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CreateTopicRequestSchema,
  IdParamsSchema,
  UpdateTopicRequestSchema,
  ServerEventSchema,
  type AppConfig,
  type HealthResponse,
} from "shared";
import type { Db } from "./db/index.ts";
import { topics } from "./db/schema.ts";
import { registerEpisodeRoutes } from "./episode-routes.ts";
import { registerJobRoutes, type JobRunner } from "./job-routes.ts";
import { registerSettingsRoutes } from "./settings-routes.ts";
import { registerWebAssets } from "./web-static.ts";
import { registerChatGptManagement } from "./chatgpt-management.ts";
import type { createChatGptSession } from "./providers/llm/chatgpt-session.ts";
import type { createScriptSelection } from "./chatgpt-selection.ts";
import { createJobLog, publicJobError, type Progress } from "./job-log.ts";
import { jobs } from "./db/schema.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function buildApp(options?: {
  db: Db;
  runner?: JobRunner;
  config?: AppConfig;
  events?: EventEmitter;
  providerHealth?: () => Promise<HealthResponse["providers"]>;
  webRoot?: string;
  chatgptSession?: Awaited<ReturnType<typeof createChatGptSession>>;
  scriptSelection?: ReturnType<typeof createScriptSelection>;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  if (options?.chatgptSession) registerChatGptManagement(app, options.chatgptSession, options.scriptSelection);
  if (options?.webRoot) registerWebAssets(app, options.webRoot);
  const db = options?.db;

  app.addHook("onRequest", async (request, reply) => {
    const ip = request.ip;
    const loopback = ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
    if (!loopback) {
      // Job control and progress are PC-only.
      const route = request.routeOptions.url;
      if (route === "/api/jobs" || route?.startsWith("/api/jobs/") || route === "/api/events")
        return reply.code(403).send({ error: "Job management is only available locally" });
      return reply.code(401).send({ error: "Remote access is not available" });
    }
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) ||
      (origin !== undefined && origin !== `http://${host}`) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return reply.code(403).send({ error: "Untrusted request origin" });
    }
  });
  if (!db) return app;
  app.get("/api/health", async (_request, reply) => {
    if (!options?.config || !options.providerHealth)
      return reply.code(503).send({ error: "Provider health checks unavailable" });
    return { version, profile: options.config.PROFILE, providers: await options.providerHealth() };
  });
  const events = options?.events ?? new EventEmitter();
  const jobLog = options?.config ? createJobLog(options.config.DATA_DIR) : undefined;
  const stageStarts = new Map<string, number>();
  const record = (jobId: string, progress: Progress) => {
    try { jobLog?.append(jobId, progress); } catch { /* Logging must not stop generation. */ }
  };
  const onStage = (event: unknown) => {
    const parsed = ServerEventSchema.safeParse(event);
    if (!parsed.success || parsed.data.type !== "job-stage") return;
    const { jobId, stage, status } = parsed.data;
    if (status === "pending") return;
    const key = `${jobId}:${stage}`;
    const start = stageStarts.get(key);
    if (status === "running") stageStarts.set(key, Date.now());
    else stageStarts.delete(key);
    record(jobId, { kind: "stage", stage, status, ...(status !== "running" && start !== undefined ? { elapsedMs: Date.now() - start } : {}) });
  };
  const onProgress = (jobId: string, progress: Progress) => record(jobId, progress);
  events.on("event", onStage);
  events.on("job-progress", onProgress);
  app.addHook("onClose", async () => { events.off("event", onStage); events.off("job-progress", onProgress); });
  app.get<{ Params: { id: string } }>("/api/jobs/:id/log", async (request, reply) => {
    if (!db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, request.params.id)).get())
      return reply.code(404).send({ error: "Job not found" });
    try {
      if (!jobLog) return reply.code(503).send({ error: "Progress log unavailable" });
      return reply.header("cache-control", "no-store").send(jobLog.read(request.params.id));
    } catch { return reply.code(503).send({ error: "Progress log unavailable" }); }
  });
  const streams = new Set<PassThrough>();
  app.addHook("preClose", (done) => {
    for (const stream of streams) stream.end();
    done();
  });
  app.get("/api/events", async (_request, reply) => {
    const stream = new PassThrough();
    streams.add(stream);
    const listener = (event: unknown) => {
      const parsed = ServerEventSchema.safeParse(event);
      if (!parsed.success) return;
      const safe = parsed.data.type === "job-stage" && parsed.data.error !== undefined
        ? { ...parsed.data, error: publicJobError(parsed.data.error) ?? undefined }
        : parsed.data;
      if (!stream.write(`data: ${JSON.stringify(safe)}\n\n`)) stream.destroy();
    };
    events.on("event", listener);
    const progressListener = (jobId: string) => {
      if (!stream.write(`event: job-log\ndata: ${JSON.stringify({ jobId })}\n\n`)) stream.destroy();
    };
    events.on("job-progress", progressListener);
    reply.raw.on("close", () => {
      events.off("event", listener);
      events.off("job-progress", progressListener);
      streams.delete(stream);
      stream.destroy();
    });
    stream.write(": connected\n\n");
    return reply.header("cache-control", "no-cache").type("text/event-stream").send(stream);
  });
  registerEpisodeRoutes(app, db, options?.config?.DATA_DIR);
  registerJobRoutes(app, db, options?.runner, options?.config);
  if (options?.config) registerSettingsRoutes(app, db, options.config);

  app.get("/api/topics", async () => ({ topics: db.select().from(topics).all() }));
  app.post("/api/topics", async (request, reply) => {
    const parsed = CreateTopicRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const topic = {
      ...parsed.data,
      id: randomUUID(),
      level: parsed.data.level ?? null,
      schedule: parsed.data.schedule ?? null,
      lastRunAt: null,
    };
    db.insert(topics).values(topic).run();
    return reply.code(201).send(topic);
  });
  app.patch("/api/topics/:id", async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const body = UpdateTopicRequestSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ error: "Invalid topic update" });
    const updated = db
      .update(topics)
      .set(body.data)
      .where(eq(topics.id, params.data.id))
      .returning()
      .get();
    if (!updated) return reply.code(404).send({ error: "Topic not found" });
    return updated;
  });
  app.delete("/api/topics/:id", async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid topic id" });
    const deleted = db.delete(topics).where(eq(topics.id, params.data.id)).returning().get();
    if (!deleted) return reply.code(404).send({ error: "Topic not found" });
    return { ok: true };
  });
  return app;
}
