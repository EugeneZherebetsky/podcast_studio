import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CreateTopicRequestSchema,
  IdParamsSchema,
  UpdateTopicRequestSchema,
  type AppConfig,
} from "shared";
import type { Db } from "./db/index.ts";
import { topics } from "./db/schema.ts";
import { registerEpisodeRoutes } from "./episode-routes.ts";
import { registerJobRoutes, type JobRunner } from "./job-routes.ts";
import { registerSettingsRoutes } from "./settings-routes.ts";

export function buildApp(options?: {
  db: Db;
  runner?: JobRunner;
  config?: AppConfig;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  // Pairing and token verification arrive in T17: fail closed until then.
  app.addHook("onRequest", async (request, reply) => {
    const ip = request.ip;
    if (ip !== "::1" && !ip.startsWith("127.") && !ip.startsWith("::ffff:127.")) {
      return reply.code(401).send({ error: "Remote access is not available" });
    }
  });
  const db = options?.db;
  if (!db) return app;
  registerEpisodeRoutes(app, db);
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
