import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { vocab } from "../src/db/schema.ts";

test("vocabulary upload is absent and existing cards are preserved", async () => {
  const db = openDatabase(":memory:");
  const card = { lemma: "alma", lang: "hu", gloss: "apple", state: "new" as const, dueAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", card: {} };
  db.insert(vocab).values(card).run();
  const app = buildApp({ db });
  try {
    expect((await app.inject({ method: "POST", url: "/api/sync/vocab", payload: { cards: [{ ...card, gloss: "changed" }] } })).statusCode).toBe(404);
    expect(db.select().from(vocab).all()).toEqual([card]);
  } finally { await app.close(); db.$client.close(); }
});
