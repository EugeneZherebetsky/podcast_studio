// Cost bookkeeping (ARCHITECTURE §3 "Cost guard"): every billable provider call becomes a
// row in the `usage` table; the budget guard compares the month's total with the budget.
import { and, gte, lt, sum } from "drizzle-orm";
import type { Db } from "./db/index.ts";
import { usage as usageTable } from "./db/schema.ts";
import type { Usage } from "./providers/llm/interface.ts";

export interface RecordUsageOptions {
  /** Job the call belongs to; omit for calls outside a job. */
  jobId?: string;
  /** Time of the call; defaults to now. */
  now?: Date;
}

/** Writes one `llm` row: units are input + output tokens, cost is the provider's estimate. */
export function recordLlmUsage(db: Db, usage: Usage, options: RecordUsageOptions = {}): void {
  db.insert(usageTable)
    .values({
      ts: (options.now ?? new Date()).toISOString(),
      provider: usage.provider,
      kind: "llm",
      units: usage.inputTokens + usage.outputTokens,
      costUsd: usage.costUsd,
      jobId: options.jobId ?? null,
    })
    .run();
}

/**
 * Total recorded cost, over every kind of usage, in the calendar month (UTC) that contains
 * `now`. Timestamps are ISO 8601 UTC strings, so comparing them as text is exact.
 */
export function monthTotalCostUsd(db: Db, now: Date = new Date()): number {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const row = db
    .select({ total: sum(usageTable.costUsd) })
    .from(usageTable)
    .where(and(gte(usageTable.ts, start.toISOString()), lt(usageTable.ts, end.toISOString())))
    .get();
  return Number(row?.total ?? 0);
}
