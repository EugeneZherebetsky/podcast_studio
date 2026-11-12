import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

test("vocabulary sync preserves newer server rows and returns absent rows", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  const card = { lemma: "alma", lang: "hu", gloss: "apple", state: "new", dueAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", card: {} };
  try {
    const send = (cards: unknown[]) => app.inject({ method: "POST", url: "/api/sync/vocab", payload: { cards } });
    expect((await send([card])).statusCode).toBe(200);
    const stale = { ...card, gloss: "stale", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect((await send([stale])).json()).toEqual({ cards: [card] });
    expect((await send([])).json()).toEqual({ cards: [card] });
    const newer = { ...card, gloss: "fruit", updatedAt: "2026-01-03T00:00:00.000Z" };
    expect((await send([newer])).json()).toEqual({ cards: [] });
    expect((await send([])).json()).toEqual({ cards: [newer] });
  } finally {
    await app.close();
    db.$client.close();
  }
});
