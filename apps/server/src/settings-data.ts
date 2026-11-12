import { readFile } from "node:fs/promises";
import type { Lang } from "shared";
import type { Db } from "./db/index.ts";
import type { SynthesizeRequest, TtsProvider } from "./providers/tts/interface.ts";
import { monthTotalCostUsd } from "./usage.ts";

/** Internal building blocks only; preview calls are not yet billed or exposed over HTTP. */
export function createSettingsData(db: Db, tts: TtsProvider) {
  return {
    usage: (now?: Date) => monthTotalCostUsd(db, now),
    voices: (lang: Lang) => tts.voices(lang),
    preview: async (request: SynthesizeRequest) => readFile((await tts.synthesize(request)).wavPath),
  };
}
