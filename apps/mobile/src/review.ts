import { createEmptyCard, fsrs, State, type Card, type Grade } from "ts-fsrs";

const scheduler = fsrs({ enable_fuzz: false });
type StoredCard = Omit<Card, "due" | "last_review"> & { due: Date | string; last_review?: Date | string };

export function newCard(now: Date): Card {
  return createEmptyCard(now);
}

export function scheduleCard(card: StoredCard, rating: Grade, now: Date): Card {
  return scheduler.next({ ...card, due: new Date(card.due), last_review: card.last_review ? new Date(card.last_review) : undefined }, now, rating).card;
}

export function selectDueCards<T extends { card: StoredCard }>(cards: T[], now: Date, limit: number, introduced: number): T[] {
  const due = cards.filter(({ card }) => new Date(card.due).getTime() <= now.getTime());
  return [...due.filter(({ card }) => card.state !== State.New), ...due.filter(({ card }) => card.state === State.New).slice(0, Math.max(0, limit - introduced))];
}
