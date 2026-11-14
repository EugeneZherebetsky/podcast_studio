import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { fakeGeneration } from "./generation-fakes.ts";

vi.mock("../src/pipeline/runner.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/pipeline/runner.ts")>(),
  generateJob: vi.fn(async () => {}),
}));
import { generateJob } from "../src/pipeline/runner.ts";

test.each([
  { lang: "en", selected: true, expected: "native-chosen" },
  { lang: "hu", selected: true, expected: "hu-chosen" },
  { lang: "en", selected: false, expected: "web-saved" },
  { lang: "hu", selected: false, expected: "web-hu" },
])("voice precedence for $lang with native selection $selected preserves web settings", async ({ lang, selected, expected }) => {
  vi.mocked(generateJob).mockClear();
  const f = fakeGeneration();
  const config = parseConfig({ PROFILE: "local", TTS_VOICE_NATIVE_HOST: "native-chosen", TTS_VOICE_HU_HOST: "hu-chosen" });

  const runner = createDesktopRunner(f.deps, new EventEmitter(), config, undefined, undefined, selected);
  const app = buildApp({ db: f.db, config, runner });
  try {
    const saved = await app.inject({ method: "PUT", url: "/api/settings", payload: { voices: { nativeHost: "web-saved", huHost: "web-hu" } } });
    expect(saved.statusCode).toBe(200);
    await runner.create({ title: "Bees", brief: "", mode: "standard", lang, minutes: 1, review: false });
    await vi.waitFor(() => expect(generateJob).toHaveBeenCalled());
    expect(vi.mocked(generateJob).mock.calls[0]![0].voice).toBe(expected);
    expect((await app.inject({ url: "/api/settings" })).json().voices.nativeHost).toBe("web-saved");
  } finally { await runner.close(); await app.close(); f.close(); }
}, 40000);

test("configured cloud voice still wins over native selection without making a request", async () => {
  vi.mocked(generateJob).mockClear();
  const f = fakeGeneration();
  const config = parseConfig({ PROFILE: "local", TTS_VOICE_NATIVE_HOST: "native-chosen", FISH_AUDIO_API_KEY: "fixture" });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), config, undefined, undefined, true);
  const app = buildApp({ db: f.db, config, runner });
  try {
    const saved = await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: { provider: "fish", model: "s2.1-pro-free", voice: "cloud-voice", inputLimit: 5000 } } });
    expect(saved.statusCode).toBe(200);
    await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false });
    await vi.waitFor(() => expect(generateJob).toHaveBeenCalled());
    expect(vi.mocked(generateJob).mock.calls[0]![0].voice).toBe("cloud-voice");
  } finally { await runner.close(); await app.close(); f.close(); }
});
