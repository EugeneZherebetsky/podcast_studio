import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Lang } from "shared";
import { countChars, type SynthesizeRequest, type SynthesizeResult, type TtsProvider, type Voice } from "./interface.ts";
import { encodeWav, sineTone, WAV_SAMPLE_RATE } from "./wav.ts";

export interface FakeTtsOptions {
  /** Directory the WAV files are written to; created if missing. */
  outDir: string;
  /** Tone duration per character of text. Default 50 ms. */
  msPerChar?: number;
  /**
   * Tone frequency, fixed or chosen per request (e.g. one frequency per segment, so a
   * test can find segment boundaries in assembled audio). Default 440 Hz.
   */
  frequencyHz?: number | ((request: SynthesizeRequest) => number);
}

/**
 * Writes a real WAV file holding one sine tone instead of speech. The duration depends
 * only on the text length (`msPerChar` per character, counted as code points); `rate`
 * and `voice` do not change the audio. The same request always gives the same file.
 */
export class FakeTtsProvider implements TtsProvider {
  readonly calls: SynthesizeRequest[] = [];
  readonly msPerChar: number;
  private readonly outDir: string;
  private readonly frequencyHz: number | ((request: SynthesizeRequest) => number);

  constructor(options: FakeTtsOptions) {
    this.outDir = path.resolve(options.outDir);
    this.msPerChar = options.msPerChar ?? 50;
    this.frequencyHz = options.frequencyHz ?? 440;
    if (!(this.msPerChar > 0)) throw new Error("FakeTtsProvider: msPerChar must be positive");
  }

  forRun(dir: string): TtsProvider {
    return new FakeTtsProvider({ outDir: dir, msPerChar: this.msPerChar, frequencyHz: this.frequencyHz });
  }

  /** Number of samples `synthesize` writes for this text. */
  expectedSamples(text: string): number {
    return Math.round((countChars(text) * this.msPerChar * WAV_SAMPLE_RATE) / 1000);
  }

  async voices(lang: Lang): Promise<Voice[]> {
    const primary = lang.split("-")[0]!.toLowerCase();
    return [
      { id: `fake-${primary}-a`, name: `Fake A (${primary})`, lang: primary, gender: "female" },
      { id: `fake-${primary}-b`, name: `Fake B (${primary})`, lang: primary, gender: "male" },
    ];
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    this.calls.push({ ...request });
    const chars = countChars(request.text);
    if (chars === 0) throw new Error("FakeTtsProvider: cannot synthesize empty text");

    const frequencyHz =
      typeof this.frequencyHz === "function" ? this.frequencyHz(request) : this.frequencyHz;
    if (!(frequencyHz > 0 && frequencyHz < WAV_SAMPLE_RATE / 2)) {
      throw new Error(
        `FakeTtsProvider: frequency must be between 0 and ${WAV_SAMPLE_RATE / 2} Hz, got ${frequencyHz}`,
      );
    }

    const key = JSON.stringify([
      request.voice,
      request.rate,
      request.lang,
      request.text,
      frequencyHz,
      this.msPerChar,
    ]);
    const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
    const wavPath = path.join(this.outDir, `${name}.wav`);
    mkdirSync(this.outDir, { recursive: true });
    writeFileSync(wavPath, encodeWav(sineTone(frequencyHz, this.expectedSamples(request.text))));
    return { wavPath, chars };
  }
}


