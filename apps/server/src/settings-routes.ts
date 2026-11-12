import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SettingsSchema, UpdateSettingsRequestSchema, type AppConfig, type Settings } from "shared";
import type { Db } from "./db/index.ts";
import { settings } from "./db/schema.ts";

export function registerSettingsRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  const defaults: Settings = {
    profile: config.PROFILE,
    nativeLang: config.NATIVE_LANG,
    targetLang: config.TARGET_LANG,
    level: config.LEARNER_LEVEL,
    monthlyBudgetUsd: config.MONTHLY_BUDGET_USD,
    voices: {
      huHost: config.TTS_VOICE_HU_HOST,
      huCohost: config.TTS_VOICE_HU_COHOST,
      nativeHost: config.TTS_VOICE_NATIVE_HOST ?? null,
      nativeTeacher: config.TTS_VOICE_NATIVE_TEACHER ?? null,
    },
  };
  function current(): Settings {
    const row = db.select().from(settings).where(eq(settings.key, "api-settings")).get();
    return row ? SettingsSchema.parse(row.value) : defaults;
  }
  app.get("/api/settings", async () => current());
  app.put("/api/settings", async (request, reply) => {
    const parsed = UpdateSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const previous = current();
    const next = SettingsSchema.parse({
      ...previous,
      ...parsed.data,
      voices: { ...previous.voices, ...parsed.data.voices },
    });
    db.insert(settings)
      .values({ key: "api-settings", value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next } })
      .run();
    return next;
  });
}
