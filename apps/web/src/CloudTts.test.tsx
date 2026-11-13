import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { CloudTts } from "./CloudTts.tsx";

test("cloud TTS exposes provider, model, voice and limit with billing disclosure", () => {
  const html = renderToString(<CloudTts status={{ elevenlabsConfigured: true, fishConfigured: false }} value={{ provider: "fish", model: "s2.1-pro-free", voice: "voice-id", inputLimit: 5000 }} onChange={() => {}} />);
  expect(html).toContain("ElevenLabs");
  expect(html).toContain("Fish Audio");
  expect(html).toContain("voice-id");
  expect(html).toContain("5000");
  expect(html).toContain("separately billed");
  expect(html).toContain("sent to the provider");

  expect(html).toContain("Piper");
  expect(html).toContain("How to connect a cloud voice");
  expect(html).toContain("ELEVENLABS_API_KEY=your_api_key_here");
  expect(html).toContain("FISH_AUDIO_API_KEY=your_api_key_here");
  expect(html).toContain("Save settings");
  expect(html).toContain("https://docs.fish.audio/developer-guide/getting-started/api-key");
});
