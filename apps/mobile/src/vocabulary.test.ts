import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Rating } from "ts-fsrs";
import { vocabularyStore } from "./vocabulary";

const now = new Date("2026-01-01T12:00:00.000Z");
const word = { token: { surface: "ház", lemma: "ház", pos: "noun", gloss: "house" }, sentence: "A ház.", translation: "The house.", episodeId: "episode", startMs: 100, endMs: 900 };

test("saves without overwriting progress and enforces daily introductions across reopening", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...params: (string | number | null)[]) => { raw.prepare(sql).run(...params); },
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) => raw.prepare(sql).all(...params) as T[],
  };
  const store = await vocabularyStore(db);
  await store.save(word, now);
  await store.save({ ...word, token: { ...word.token, lemma: "kutya" } }, now);
  let queue = await store.due(now, 1);
  expect(queue).toHaveLength(1);
  await store.rate(queue[0].id, Rating.Good, now);
  await store.save(word, now);
  const reopened = await vocabularyStore(db);
  expect(await reopened.due(now, 1)).toHaveLength(0);
  queue = await reopened.due(new Date("2026-01-02T12:00:00.000Z"), 1);
  expect(queue.some((row) => row.card.reps === 1)).toBe(true);
  expect(queue.some((row) => row.card.reps === 0)).toBe(true);
  raw.close();
});
