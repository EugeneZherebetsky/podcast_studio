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

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function buildApp(options?: {
  db: Db;
  runner?: JobRunner;
  config?: AppConfig;
  events?: EventEmitter;
  providerHealth?: () => Promise<HealthResponse["providers"]>;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  // Pairing and token verification arrive in T17: fail closed until then.
  app.addHook("onRequest", async (request, reply) => {
    const ip = request.ip;
    if (ip !== "::1" && !ip.startsWith("127.") && !ip.startsWith("::ffff:127.")) {
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
  const db = options?.db;
  if (!db) return app;
  app.get("/api/health", async (_request, reply) => {
    if (!options?.config || !options.providerHealth)
      return reply.code(503).send({ error: "Provider health checks unavailable" });
    return { version, profile: options.config.PROFILE, providers: await options.providerHealth() };
  });
  const events = options?.events ?? new EventEmitter();
  app.get("/api/events", async (_request, reply) => {
    const stream = new PassThrough();
    const listener = (event: unknown) => {
      const parsed = ServerEventSchema.safeParse(event);
      if (parsed.success) stream.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
    };
    events.on("event", listener);
    reply.raw.on("close", () => {
      events.off("event", listener);
      stream.destroy();
    });
    stream.write(": connected\n\n");
    return reply.header("cache-control", "no-cache").type("text/event-stream").send(stream);
  });
  registerEpisodeRoutes(app, db, options?.config?.DATA_DIR);
  registerJobRoutes(app, db, options?.runner);
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
