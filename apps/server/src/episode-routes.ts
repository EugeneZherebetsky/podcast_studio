import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EpisodeSchema, EpisodeSummarySchema, GetEpisodeResponseSchema, ListEpisodesQuerySchema } from "shared";
import type { Db } from "./db/index.ts";
import { episodes } from "./db/schema.ts";

export function registerEpisodeRoutes(app: FastifyInstance, db: Db, dataDir?: string): void {
  app.get<{ Params: { id: string; file: string } }>("/api/episodes/:id/usb/:file", async (request, reply) => {
    const ip = request.ip;
    if (ip !== "::1" && !ip.startsWith("127.") && !ip.startsWith("::ffff:127."))
      return reply.code(403).send({ error: "USB export is only available locally" });
    const { id, file } = request.params;
    if (file !== "episode.json" && file !== "audio.m4a") return reply.code(404).send({ error: "File not found" });
    const row = db.select().from(episodes).where(eq(episodes.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Episode not found" });
    let stagingDir: string | undefined;
    try {
      if (!dataDir || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("unsafe path");
      const root = path.resolve(dataDir, "episodes");
      const dir = path.join(root, id);
      if (path.resolve(row.path) !== dir || await realpath(root) !== path.join(await realpath(dataDir), "episodes") || await realpath(dir) !== path.join(await realpath(root), id)) throw new Error("unsafe path");
      for (const name of ["episode.json", "audio.m4a"]) {
        if (!(await lstat(path.join(dir, name))).isFile()) throw new Error("unsafe file");
      }
      const metadata = await readFile(path.join(dir, "episode.json"));
      const episode = EpisodeSchema.parse(JSON.parse(metadata.toString("utf8")));
      if (episode.id !== id) throw new Error("episode mismatch");
      stagingDir = await mkdtemp(path.join(tmpdir(), "podcast-usb-"));
      const stagedAudio = path.join(stagingDir, "audio.m4a");
      await copyFile(path.join(dir, "audio.m4a"), stagedAudio);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(stagedAudio)) {
        const buffer = chunk as Buffer;
        bytes += buffer.length;
        hash.update(buffer);
      }
      if (bytes !== episode.audio.bytes || hash.digest("hex") !== episode.audio.sha256) throw new Error("audio mismatch");
      reply.header("cache-control", "no-store").header("content-disposition", `attachment; filename="${file}"`);
      if (file === "episode.json") {
        await rm(stagingDir, { recursive: true, force: true });
        stagingDir = undefined;
        return reply.type("application/json").send(episode);
      }
      const stream = createReadStream(stagedAudio);
      const cleanupDir = stagingDir;
      stream.once("close", () => { void rm(cleanupDir, { recursive: true, force: true }).catch(() => {}); });
      reply.raw.once("close", () => stream.destroy());
      stagingDir = undefined;
      return reply.type("audio/mp4").send(stream);
    } catch {
      if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return reply.code(422).send({ error: "Episode package is unavailable, unsafe, or failed integrity verification" });
    }
  });
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
