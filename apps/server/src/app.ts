import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { and, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CreateTopicRequestSchema,
  PairCompleteRequestSchema,
  PairCompleteResponseSchema,
  PairStartResponseSchema,
  IdParamsSchema,
  UpdateTopicRequestSchema,
  ServerEventSchema,
  SyncPlaybackRequestSchema,
  SyncVocabRequestSchema,
  SyncVocabResponseSchema,
  type AppConfig,
  type HealthResponse,
} from "shared";
import type { Db } from "./db/index.ts";
import { devices, episodes, playback, topics, vocab } from "./db/schema.ts";
import { registerEpisodeRoutes } from "./episode-routes.ts";
import { registerJobRoutes, type JobRunner } from "./job-routes.ts";
import { registerSettingsRoutes } from "./settings-routes.ts";
import { registerWebAssets } from "./web-static.ts";
import { registerChatGptManagement } from "./chatgpt-management.ts";
import type { createChatGptSession } from "./providers/llm/chatgpt-session.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function buildApp(options?: {
  db: Db;
  runner?: JobRunner;
  config?: AppConfig;
  events?: EventEmitter;
  providerHealth?: () => Promise<HealthResponse["providers"]>;
  webRoot?: string;
  chatgptSession?: Awaited<ReturnType<typeof createChatGptSession>>;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  if (options?.chatgptSession) registerChatGptManagement(app, options.chatgptSession);
  if (options?.webRoot) registerWebAssets(app, options.webRoot);
  const db = options?.db;
  let pairing: { code: string; expires: number; attempts: number } | undefined;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const deviceFor = (authorization: string | undefined) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    return match && db?.select().from(devices).where(eq(devices.tokenHash, hash(match[1]!))).get();
  };
  app.addHook("onRequest", async (request, reply) => {
    const ip = request.ip;
    const loopback = ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
    if (!loopback) {
      // Job control and progress are PC-only, even for legacy paired devices.
      const route = request.routeOptions.url;
      if (route === "/api/jobs" || route?.startsWith("/api/jobs/") || route === "/api/events")
        return reply.code(403).send({ error: "Job management is only available locally" });
      if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined)
        return reply.code(403).send({ error: "Untrusted request origin" });
      if (request.method === "POST" && request.routeOptions.url === "/api/pair/complete") return;
      const device = deviceFor(request.headers.authorization);
      if (!device) return reply.code(401).send({ error: "Remote access is not available" });
      db!.update(devices).set({ lastSeenAt: new Date().toISOString() }).where(eq(devices.id, device.id)).run();
      return;
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
  app.post("/api/pair/start", async (request, reply) => {
    const ip = request.ip;
    if (ip !== "::1" && !ip.startsWith("127.") && !ip.startsWith("::ffff:127."))
      return reply.code(401).send({ error: "Remote access is not available" });
    pairing = { code: randomBytes(32).toString("base64url"), expires: Date.now() + 5 * 60_000, attempts: 0 };
    const qr = new URL("podcast-studio://pair");
    qr.searchParams.set("host", request.headers.host ?? "localhost");
    qr.searchParams.set("code", pairing.code);
    return reply.header("cache-control", "no-store").send(PairStartResponseSchema.parse({ qr: qr.toString() }));
  });
  app.post("/api/pair/complete", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const parsed = PairCompleteRequestSchema.safeParse(request.body);
    if (!pairing || pairing.expires <= Date.now() || pairing.attempts >= 10) {
      pairing = undefined;
      return reply.code(401).send({ error: "Invalid pairing code" });
    }
    pairing.attempts++;
    if (!parsed.success || parsed.data.code !== pairing.code || parsed.data.deviceName.length > 128)
      return reply.code(401).send({ error: "Invalid pairing code" });
    pairing = undefined;
    const token = randomBytes(32).toString("base64url");
    db.insert(devices).values({ id: randomUUID(), name: parsed.data.deviceName, tokenHash: hash(token), createdAt: new Date().toISOString() }).run();
    return PairCompleteResponseSchema.parse({ token });
  });
  app.get("/api/health", async (_request, reply) => {
    if (!options?.config || !options.providerHealth)
      return reply.code(503).send({ error: "Provider health checks unavailable" });
    return { version, profile: options.config.PROFILE, providers: await options.providerHealth() };
  });
  const events = options?.events ?? new EventEmitter();
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
      if (parsed.success && !stream.write(`data: ${JSON.stringify(parsed.data)}\n\n`)) stream.destroy();
    };
    events.on("event", listener);
    reply.raw.on("close", () => {
      events.off("event", listener);
      streams.delete(stream);
      stream.destroy();
    });
    stream.write(": connected\n\n");
    return reply.header("cache-control", "no-cache").type("text/event-stream").send(stream);
  });
  registerEpisodeRoutes(app, db, options?.config?.DATA_DIR);
  registerJobRoutes(app, db, options?.runner, options?.config);
  if (options?.config) registerSettingsRoutes(app, db, options.config);

  app.post("/api/sync/playback", async (request, reply) => {
    const device = deviceFor(request.headers.authorization);
    if (!device) return reply.code(401).send({ error: "Device authentication required" });
    const parsed = SyncPlaybackRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid playback sync" });
    const missing = parsed.data.positions.some((position) =>
      !db.select({ id: episodes.id }).from(episodes).where(eq(episodes.id, position.episodeId)).get(),
    );
    if (missing) return reply.code(400).send({ error: "Unknown episode" });
    db.transaction((tx) => {
      for (const position of parsed.data.positions) {
        const existing = tx.select().from(playback).where(and(eq(playback.episodeId, position.episodeId), eq(playback.deviceId, device.id))).get();
        if (!existing || Date.parse(position.updatedAt) > Date.parse(existing.updatedAt)) {
          tx.insert(playback).values({ ...position, deviceId: device.id }).onConflictDoUpdate({
            target: [playback.episodeId, playback.deviceId],
            set: position,
          }).run();
        }
      }
    });
    return { ok: true };
  });

  app.post("/api/sync/vocab", async (request, reply) => {
    const parsed = SyncVocabRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid vocabulary sync" });
    const sent = new Map<string, number>();
    const key = (lemma: string, lang: string) => JSON.stringify([lemma, lang]);
    const result = db.transaction((tx) => {
      for (const card of parsed.data.cards) {
        const id = key(card.lemma, card.lang);
        sent.set(id, Math.max(sent.get(id) ?? -Infinity, Date.parse(card.updatedAt)));
        const existing = tx.select().from(vocab).where(and(eq(vocab.lemma, card.lemma), eq(vocab.lang, card.lang))).get();
        if (!existing || Date.parse(card.updatedAt) > Date.parse(existing.updatedAt)) {
          tx.insert(vocab).values(card).onConflictDoUpdate({
            target: [vocab.lemma, vocab.lang],
            set: card,
          }).run();
        }
      }
      return tx.select().from(vocab).all().filter((row) =>
        Date.parse(row.updatedAt) > (sent.get(key(row.lemma, row.lang)) ?? -Infinity),
      );
    });
    return SyncVocabResponseSchema.parse({ cards: result });
  });

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
