import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EpisodeSummarySchema, GetEpisodeResponseSchema, ListEpisodesQuerySchema } from "shared";
import type { Db } from "./db/index.ts";
import { episodes } from "./db/schema.ts";

export function registerEpisodeRoutes(app: FastifyInstance, db: Db, dataDir?: string): void {
  app.delete<{ Params: { id: string } }>("/api/episodes/:id", async (request, reply) => {
    const episode = db.select().from(episodes).where(eq(episodes.id, request.params.id)).get();
    if (!episode) return reply.code(404).send({ error: "Episode not found" });
    if (!dataDir || !/^[a-zA-Z0-9_-]+$/.test(episode.id))
      return reply.code(500).send({ error: "Episode package path is unsafe" });
    const root = path.resolve(dataDir, "episodes");
    const expected = path.join(root, episode.id);
    if (path.resolve(episode.path) !== expected)
      return reply.code(500).send({ error: "Episode package path is unsafe" });
    let exists: boolean;
    try {
      exists = await lstat(expected).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists) {
        const actualRoot = await realpath(root);
        const actual = await realpath(expected);
        if (actualRoot !== path.join(await realpath(dataDir), "episodes") ||
          actual !== path.join(actualRoot, episode.id))
          return reply.code(500).send({ error: "Episode package path is unsafe" });
        await rm(expected, { recursive: true });
      }
    } catch {
      return reply.code(500).send({ error: "Episode package could not be removed" });
    }
    db.delete(episodes).where(eq(episodes.id, episode.id)).run();
    return { ok: true };
  });
  app.get("/api/episodes", async (request, reply) => {
    const query = ListEpisodesQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid since parameter" });
    const rows = query.data.since
      ? db.select().from(episodes).where(gt(episodes.createdAt, query.data.since)).all()
      : db.select().from(episodes).all();
    return { episodes: rows.map((row) => EpisodeSummarySchema.parse(row)) };
  });
  app.get<{ Params: { id: string } }>("/api/episodes/:id", async (request, reply) => {
    const episode = db.select().from(episodes).where(eq(episodes.id, request.params.id)).get();
    if (!episode) return reply.code(404).send({ error: "Episode not found" });
    try {
      return GetEpisodeResponseSchema.parse(
        JSON.parse(await readFile(path.join(episode.path, "episode.json"), "utf8")),
      );
    } catch {
      return reply.code(500).send({ error: "Episode package unavailable or invalid" });
    }
  });
  app.get<{ Params: { id: string } }>("/api/episodes/:id/audio", async (request, reply) => {
    const episode = db.select().from(episodes).where(eq(episodes.id, request.params.id)).get();
    if (!episode) return reply.code(404).send({ error: "Episode not found" });
    const file = path.join(episode.path, "audio.m4a");
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return reply.code(404).send({ error: "Audio not found" });
    }
    reply.header("accept-ranges", "bytes").type("audio/mp4");
    const range = request.headers.range;
    if (!range) return reply.header("content-length", size).send(createReadStream(file));
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = match?.[1] ? Number(match[1]) : 0;
    let end = match?.[2] ? Number(match[2]) : size - 1;
    if (match && !match[1] && match[2]) {
      start = Math.max(0, size - end);
      end = size - 1;
    }
    if (
      !match ||
      (!match[1] && !match[2]) ||
      size === 0 ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= size ||
      start > end ||
      (!match[1] && Number(match[2]) === 0)
    ) {
      return reply
        .code(416)
        .header("content-range", `bytes */${size}`)
        .type("application/json")
        .send({ error: "Range not satisfiable" });
    }
    end = Math.min(end, size - 1);
    return reply
      .code(206)
      .header("content-range", `bytes ${start}-${end}/${size}`)
      .header("content-length", end - start + 1)
      .send(createReadStream(file, { start, end }));
  });
}
