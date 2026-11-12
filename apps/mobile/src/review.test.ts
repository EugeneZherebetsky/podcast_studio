import { describe, expect, test } from "vitest";
import { Rating, State } from "ts-fsrs";
import { newCard, scheduleCard, selectDueCards } from "./review";

const now = new Date("2026-01-01T12:00:00.000Z");

describe("local review", () => {
  test("schedules each rating with a fixed clock and preserves serialized dates", () => {
    const initial = newCard(now);
    for (const rating of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const) {
      const result = scheduleCard(initial, rating, now);
      expect(result.reps).toBe(1);
      expect(result.last_review?.toISOString()).toBe(now.toISOString());
      expect(result.due.getTime()).toBeGreaterThan(now.getTime());
      expect(scheduleCard(JSON.parse(JSON.stringify(result)), rating, result.due).reps).toBe(2);
    }
    expect(scheduleCard(initial, Rating.Easy, now).state).toBe(State.Review);
  });

  test("limits new cards without limiting due learning cards", () => {
    const fresh = newCard(now);
    const learning = scheduleCard(fresh, Rating.Again, now);
    const due = new Date(learning.due.getTime() + 1);
    const cards = [{ id: 1, card: fresh }, { id: 2, card: fresh }, { id: 3, card: learning }];
    expect(selectDueCards(cards, due, 1, 0).map((c) => c.id)).toEqual([3, 1]);
    expect(selectDueCards(cards, due, 1, 1).map((c) => c.id)).toEqual([3]);
  });
});
