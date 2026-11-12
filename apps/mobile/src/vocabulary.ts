import type { Token } from "shared";
import { State, type Card, type Grade } from "ts-fsrs";
import { newCard, scheduleCard, selectDueCards } from "./review";

type Database = {
  execAsync(sql: string): Promise<unknown>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
};
export type SavedWord = { token: Token; sentence: string; translation?: string; episodeId: string; startMs: number; endMs: number };
export type ReviewWord = SavedWord & { id: number; card: Card };
type Row = { id: number; word: string; card: string; introduced_day: string | null };

function day(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export async function vocabularyStore(db: Database) {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS local_vocabulary (
    id INTEGER PRIMARY KEY NOT NULL, lemma TEXT NOT NULL UNIQUE, word TEXT NOT NULL,
    card TEXT NOT NULL, introduced_day TEXT
  )`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS local_review_days (day TEXT PRIMARY KEY NOT NULL);
    CREATE TRIGGER IF NOT EXISTS local_record_review_day AFTER UPDATE OF card ON local_vocabulary
    BEGIN
      INSERT OR IGNORE INTO local_review_days (day)
      VALUES (date(json_extract(NEW.card, '$.last_review'), 'localtime'));
    END`);
  const rows = () => db.getAllAsync<Row>("SELECT id, word, card, introduced_day FROM local_vocabulary ORDER BY id");
  return {
    async save(word: SavedWord, now = new Date()) {
      await db.runAsync("INSERT OR IGNORE INTO local_vocabulary (lemma, word, card) VALUES (?, ?, ?)", word.token.lemma, JSON.stringify(word), JSON.stringify(newCard(now)));
    },
    async due(now = new Date(), limit = 10): Promise<ReviewWord[]> {
      const all = await rows();
      const introduced = all.filter((row) => row.introduced_day === day(now)).length;
      const parsed = all.map((row) => ({ ...JSON.parse(row.word) as SavedWord, id: row.id, card: JSON.parse(row.card) as Card }));
      return selectDueCards(parsed, now, limit, introduced);
    },
    async progress(now = new Date()) {
      const all = await rows();
      const cards = all.map((row) => ({ card: JSON.parse(row.card) as Card }));
      const days = new Set((await db.getAllAsync<{ day: string }>("SELECT day FROM local_review_days")).map((row) => row.day));
      const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
      if (!days.has(day(cursor))) cursor.setDate(cursor.getDate() - 1);
      let streak = 0;
      while (days.has(day(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
      return {
        streak,
        due: selectDueCards(cards, now, 10, all.filter((row) => row.introduced_day === day(now)).length).length,
        learning: cards.filter(({ card }) => card.state === State.Learning || card.state === State.Relearning).length,
        known: cards.filter(({ card }) => card.state === State.Review).length,
        reviewed: cards.filter(({ card }) => card.last_review && day(new Date(card.last_review)) === day(now)).length,
      };
    },
    async rate(id: number, rating: Grade, now = new Date()) {
      const row = (await rows()).find((item) => item.id === id);
      if (!row) throw new Error("Card not found");
      const card = JSON.parse(row.card) as Card;
      const next = scheduleCard(card, rating, now);
      await db.runAsync("UPDATE local_vocabulary SET card = ?, introduced_day = ? WHERE id = ?", JSON.stringify(next), row.introduced_day ?? (card.state === State.New ? day(now) : null), id);
    },
  };
}
