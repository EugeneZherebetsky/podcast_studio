import { request } from "node:http";
import { createServer } from "vite";
import { expect, test } from "vitest";
import { buildApp } from "../server/src/app.ts";
import { openDatabase } from "../server/src/db/index.ts";
import config from "./vite.config.ts";

test("Vite proxies same-origin browser requests without allowing untrusted origins", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  let received: { host?: string; origin?: string } = {};
  app.server.prependListener("request", (request) => {
    received = { host: request.headers.host, origin: request.headers.origin };
  });
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const target = await app.listen({ host: "127.0.0.1", port: 0 });
    const proxy = config.server!.proxy!["/api"];
    vite = await createServer({
      ...config,
      configFile: false,
      server: {
        ...config.server,
        host: "127.0.0.1",
        port: 0,
        proxy: { "/api": typeof proxy === "string" ? target : { ...proxy, target } },
      },
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No Vite address");
    const origin = `http://127.0.0.1:${address.port}`;
    const post = (requestOrigin: string, site = "same-origin") => fetch(`${origin}/api/topics`, {
      method: "POST",
      headers: { origin: requestOrigin, "sec-fetch-site": site, "content-type": "application/json" },
      body: JSON.stringify({ title: "Test", brief: "Test", mode: "standard", lang: "en", minutes: 10 }),
    });
    expect((await post(origin)).status).toBe(201);
    expect(received).toEqual({ host: new URL(origin).host, origin });
    expect((await post("https://attacker.example", "cross-site")).status).toBe(403);
    expect((await post("http://127.0.0.1:9999", "same-site")).status).toBe(403);
    expect((await post(origin, "cross-site")).status).toBe(403);
    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${origin}/api/topics`, { headers: { host: `attacker.example:${address.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    expect(rebindingStatus).toBe(403);
    expect((await fetch(`${origin}/api/topics`)).status).toBe(200);
  } finally {
    await vite?.close();
    await app.close();
    db.$client.close();
  }
});
