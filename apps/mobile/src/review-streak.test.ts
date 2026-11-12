import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Rating } from "ts-fsrs";
import { vocabularyStore } from "./vocabulary";

test("persists consecutive review days without inferring lost history", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => { raw.prepare(sql).run(...params); },
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) => raw.prepare(sql).all(...params) as T[],
  };
  raw.exec(`CREATE TABLE local_vocabulary (id INTEGER PRIMARY KEY NOT NULL, lemma TEXT NOT NULL UNIQUE, word TEXT NOT NULL, card TEXT NOT NULL, introduced_day TEXT)`);
  const store = await vocabularyStore(db);
  const word = { token: { surface: "ház", lemma: "ház", pos: "noun", gloss: "house" }, sentence: "A ház.", episodeId: "episode", startMs: 0, endMs: 100 };
  const date = (day: number) => new Date(2026, 0, day, 12);
  await store.save(word, date(1));
  const [card] = await store.due(date(1));
  await store.rate(card.id, Rating.Good, date(1));
  await store.rate(card.id, Rating.Good, date(2));
  await store.rate(card.id, Rating.Good, date(2));
  const reopened = await vocabularyStore(db);
  expect((await reopened.progress(date(2))).streak).toBe(2);
  expect((await reopened.progress(date(3))).streak).toBe(2);
  expect((await reopened.progress(date(4))).streak).toBe(0);
  await reopened.rate(card.id, Rating.Good, date(4));
  expect((await reopened.progress(date(4))).streak).toBe(1);
  raw.close();
});
