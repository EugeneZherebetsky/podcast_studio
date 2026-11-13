import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { ensureMono24k16BitPcmWav } from "./cache.ts";
import { countChars, type SynthesizeRequest, type SynthesizeResult, type TtsProvider, type Voice } from "./interface.ts";
import { isMono24k16BitPcmWav, isWellFormedPcmWav } from "./wav.ts";

export interface CloudTtsOptions {
  provider: "elevenlabs" | "fish";
  model: string;
  apiKey: string;
  fetcher?: typeof fetch;
  dir?: string;
  signal?: AbortSignal;
}

/** A paid request is never cached or retried; a failure has an unknown billing outcome. */
export class CloudTtsProvider implements TtsProvider {
  constructor(private readonly options: CloudTtsOptions) {}
  forRun(dir: string, signal?: AbortSignal): CloudTtsProvider {
    return new CloudTtsProvider({ ...this.options, dir, signal });
  }
  async voices(): Promise<Voice[]> { return []; }
  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    const { provider, model, apiKey, dir } = this.options;
    if (!dir || !apiKey.trim() || !/^[A-Za-z0-9_-]{1,128}$/.test(request.voice)) throw new Error("Invalid cloud TTS configuration");
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
    const url = provider === "fish" ? "https://api.fish.audio/v1/tts" : `https://api.elevenlabs.io/v1/text-to-speech/${request.voice}`;
    const headers: Record<string, string> = provider === "fish" ? { Authorization: `Bearer ${apiKey}`, model } : { "xi-api-key": apiKey };
    const body = provider === "fish" ? { text: request.text, reference_id: request.voice, format: "wav", prosody: { speed: request.rate } } : { text: request.text, model_id: model, voice_settings: { speed: request.rate } };
    try {
      const response = await (this.options.fetcher ?? fetch)(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal });
      if (!response.ok || !response.body) throw new Error("Cloud TTS request failed");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) throw new Error("Cloud TTS audio too large");
        chunks.push(chunk);
      }
      await mkdir(dir, { recursive: true });
      const wavPath = path.join(dir, `${randomUUID()}.wav`);
      const audio = Buffer.concat(chunks);
      if (audio.toString("ascii", 0, 4) === "RIFF" && !isWellFormedPcmWav(audio)) throw new Error("Invalid provider WAV");
      await ensureMono24k16BitPcmWav(audio, wavPath);
      if (!isMono24k16BitPcmWav(await readFile(wavPath))) throw new Error("Invalid synthesized WAV");
      return { wavPath, chars: countChars(request.text) };
    } catch {
      // Provider responses and underlying errors may contain secrets or user text.
      throw new Error("Cloud TTS failed; the provider may have billed this request");
    }
  }
}
