import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { devices, episodes, playback } from "../src/db/schema.ts";

test("playback sync keeps the newest position per episode and authenticated device", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  const episode = { id: "ep-1", title: "Example", summary: "", mode: "standard" as const, lang: "en", durationMs: 10000, createdAt: "2026-01-01T00:00:00Z", path: "example" };
  db.insert(episodes).values(episode).run();
  try {
    const pair = async (name: string) => {
      const start = await app.inject({ method: "POST", url: "/api/pair/start" });
      const code = new URL(start.json().qr).searchParams.get("code");
      const response = await app.inject({ method: "POST", url: "/api/pair/complete", remoteAddress: "192.0.2.1", payload: { code, deviceName: name } });
      return response.json().token as string;
    };
    const first = await pair("first");
    const second = await pair("second");
    const send = (token: string, positions: unknown[]) => app.inject({ method: "POST", url: "/api/sync/playback", remoteAddress: "192.0.2.1", headers: { authorization: `Bearer ${token}` }, payload: { positions } });
    const position = { episodeId: episode.id, positionMs: 4000, finished: false, updatedAt: "2026-01-02T00:00:00Z" };
    expect((await app.inject({ method: "POST", url: "/api/sync/playback", remoteAddress: "192.0.2.1", payload: { positions: [position] } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/sync/playback", payload: { positions: [position] } })).statusCode).toBe(401);
    expect((await send(first, [{ ...position, positionMs: -1 }])).statusCode).toBe(400);
    expect((await send(first, [position, { ...position, episodeId: "missing" }])).statusCode).toBe(400);
    expect(db.select().from(playback).all()).toEqual([]);
    expect((await send(first, [position])).json()).toEqual({ ok: true });
    expect((await send(first, [{ ...position, positionMs: 1000, updatedAt: "2026-01-01T00:00:00Z" }, { ...position, positionMs: 2000 }])).statusCode).toBe(200);
    expect(db.select().from(playback).all()[0]?.positionMs).toBe(4000);
    const newer = { ...position, positionMs: 9000, finished: true, updatedAt: "2026-01-03T00:00:00Z" };
    expect((await send(first, [newer, position])).statusCode).toBe(200);
    expect((await send(second, [position])).statusCode).toBe(200);
    const rows = db.select().from(playback).all();
    const ids = db.select().from(devices).all();
    expect(rows.find((row) => row.deviceId === ids.find((device) => device.name === "first")?.id)).toMatchObject(newer);
    expect(rows.find((row) => row.deviceId === ids.find((device) => device.name === "second")?.id)).toMatchObject(position);
  } finally {
    await app.close();
    db.$client.close();
  }
});
