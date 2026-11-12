import { CronExpressionParser } from "cron-parser";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { topics } from "../db/schema.ts";

/** Call tick at least once a minute. A successful run means the runner accepted the job. */
export function createScheduler(options: {
  db: Db;
  run: (topicId: string) => Promise<void>;
  now?: () => Date;
}) {
  const baselines = new Map<string, number>();
  let pending: Promise<void> | undefined;
  async function check() {
    const now = (options.now ?? (() => new Date()))();
    const errors: Error[] = [];
    for (const topic of options.db.select().from(topics).all()) {
      try {
        if (!topic.enabled || !topic.schedule) {
          baselines.delete(topic.id);
          continue;
        }
        const baseline = topic.lastRunAt
          ? new Date(topic.lastRunAt).getTime()
          : (baselines.get(topic.id) ?? now.getTime());
        baselines.set(topic.id, baseline);
        const latest = CronExpressionParser.parse(topic.schedule, {
          currentDate: new Date(now.getTime() + 1),
        })
          .prev()
          .toDate()
          .getTime();
        if (latest <= baseline) continue;
        await options.run(topic.id);
        options.db
          .update(topics)
          .set({ lastRunAt: now.toISOString() })
          .where(eq(topics.id, topic.id))
          .run();
        baselines.set(topic.id, now.getTime());
      } catch (error) {
        errors.push(new Error(`Topic ${topic.id} scheduling failed`, { cause: error }));
      }
    }
    if (errors.length) throw new AggregateError(errors, "Topic scheduling failed");
  }
  return {
    tick(): Promise<void> {
      pending ??= check().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
