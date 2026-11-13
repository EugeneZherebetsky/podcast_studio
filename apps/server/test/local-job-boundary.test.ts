import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { devices } from "../src/db/schema.ts";

test("job management and events reject paired remote devices independently of legacy auth", async () => {
  const db = openDatabase(":memory:");
  const token = "a".repeat(43);
  db.insert(devices).values({ id: "phone", name: "phone", tokenHash: createHash("sha256").update(token).digest("hex"), createdAt: new Date().toISOString() }).run();
  const runner = { create: vi.fn(), cancel: vi.fn(), retry: vi.fn() };
  const app = buildApp({ db, runner });
  try {
    for (const [method, url] of [["GET", "/api/jobs"], ["GET", "/api/jobs/id"], ["POST", "/api/jobs"], ["POST", "/api/jobs/id/cancel"], ["POST", "/api/jobs/id/retry"], ["GET", "/api/events"]] as const) {
      const response = await app.inject({ method, url, remoteAddress: "192.0.2.1", headers: { authorization: `Bearer ${token}` }, ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode, url).toBe(403);
    }
    expect(runner.create).not.toHaveBeenCalled();
    expect(runner.cancel).not.toHaveBeenCalled();
    expect(runner.retry).not.toHaveBeenCalled();
  } finally {
    await app.close();
    db.$client.close();
  }
});

test("loopback job API remains reachable over HTTP and rejects hostile origins", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect((await fetch(`${address}/api/jobs`)).status).toBe(200);
    expect((await fetch(`${address}/api/jobs`, { headers: { origin: "https://attacker.example" } })).status).toBe(403);
    expect((await fetch(`${address}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "News", brief: "", mode: "standard", lang: "en", minutes: 8 }) })).status).toBe(503);
  } finally {
    await app.close();
    db.$client.close();
  }
});
