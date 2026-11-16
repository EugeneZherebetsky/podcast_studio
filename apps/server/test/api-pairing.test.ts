import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { devices } from "../src/db/schema.ts";

test("pairing is not registered and does not alter existing devices", async () => {
  const db = openDatabase(":memory:");
  const device = { id: "legacy", name: "phone", tokenHash: "old-hash", createdAt: "2026-01-01T00:00:00Z" };
  db.insert(devices).values(device).run();
  const app = buildApp({ db });
  try {
    for (const url of ["/api/pair/start", "/api/pair/complete"]) {
      expect((await app.inject({ method: "POST", url, payload: { code: "anything", deviceName: "phone" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url, remoteAddress: "192.0.2.1", payload: {} })).statusCode).toBe(401);
    }
    expect(db.select().from(devices).all()).toMatchObject([device]);
  } finally { await app.close(); db.$client.close(); }
});
