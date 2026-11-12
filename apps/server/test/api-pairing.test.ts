import { expect, test, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { devices } from "../src/db/schema.ts";

test("a pairing code admits one remote device and stores only a token hash", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  try {
    const start = await app.inject({ method: "POST", url: "/api/pair/start" });
    expect(start.statusCode).toBe(200);
    const code = new URL(start.json().qr).searchParams.get("code");
    const complete = () => app.inject({ method: "POST", url: "/api/pair/complete", remoteAddress: "192.0.2.1", payload: { code, deviceName: "phone" } });
    const paired = await complete();
    expect(paired.statusCode).toBe(200);
    const token = paired.json().token as string;
    expect(db.select().from(devices).get()?.tokenHash).not.toBe(token);
    expect((await complete()).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/topics", remoteAddress: "192.0.2.1" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/topics", remoteAddress: "192.0.2.1", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  } finally {
    await app.close();
    db.$client.close();
  }
});

test("pairing expires after five minutes", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  try {
    const start = await app.inject({ method: "POST", url: "/api/pair/start" });
    const code = new URL(start.json().qr).searchParams.get("code");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_000);
    expect((await app.inject({ method: "POST", url: "/api/pair/complete", payload: { code, deviceName: "phone" } })).statusCode).toBe(401);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    db.$client.close();
  }
});

test("failed guesses invalidate a pairing code and remote browsers cannot pair", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  try {
    expect((await app.inject({ method: "POST", url: "/api/pair/start", remoteAddress: "192.0.2.1" })).statusCode).toBe(401);
    const start = await app.inject({ method: "POST", url: "/api/pair/start" });
    const code = new URL(start.json().qr).searchParams.get("code");
    expect((await app.inject({ method: "POST", url: "/api/pair/complete", remoteAddress: "192.0.2.1", headers: { origin: "https://attacker.example" }, payload: { code, deviceName: "phone" } })).statusCode).toBe(403);
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: "POST", url: "/api/pair/complete", remoteAddress: "192.0.2.1", payload: { code: "wrong", deviceName: "phone" } })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/api/pair/complete", payload: { code, deviceName: "phone" } })).statusCode).toBe(401);
  } finally {
    await app.close();
    db.$client.close();
  }
});
