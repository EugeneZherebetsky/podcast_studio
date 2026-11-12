import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { episodes, usedSources } from "../db/schema.ts";

/** Inputs for the plan and search stages; publishing owns recording used sources. */
export function recurringContext(db: Db, topicId: string) {
  const previousEpisodes = db
    .select({ title: episodes.title, summary: episodes.summary })
    .from(episodes)
    .where(eq(episodes.topicId, topicId))
    .orderBy(desc(episodes.createdAt), desc(episodes.id))
    .limit(5)
    .all();
  const usedUrls = db
    .select({ url: usedSources.canonicalUrl })
    .from(usedSources)
    .where(eq(usedSources.topicId, topicId))
    .all()
    .map((row) => row.url);
  return { previousEpisodes, usedUrls };
}
