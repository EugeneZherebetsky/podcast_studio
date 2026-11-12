import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

export function registerWebAssets(app: FastifyInstance, root: string): void {
  app.setNotFoundHandler(async (request, reply) => {
    const notFound = () => reply.code(404).send({ error: "Not found" });
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();
    const urlPath = request.url.split("?", 1)[0]!;
    const name = urlPath === "/" ? "index.html" : urlPath.slice(1);
    // The app uses hash routes, so unknown paths and missing assets stay 404.
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9]+$/.test(name)) return notFound();
    const type = types[path.extname(name)];
    if (!type || name === "api" || name.startsWith("api/")) return notFound();
    try {
      const realRoot = await realpath(root);
      const file = await realpath(path.join(realRoot, name));
      const relative = path.relative(realRoot, file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return notFound();
      const data = await readFile(file);
      return reply.header("x-content-type-options", "nosniff").type(type).send(data);
    } catch {
      return notFound();
    }
  });
}
