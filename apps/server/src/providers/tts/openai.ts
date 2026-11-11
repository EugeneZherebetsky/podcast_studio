import type { Lang } from "shared";
import {
  countChars,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TtsProvider,
  type Voice,
} from "./interface.ts";
import { TtsCache, TtsHttpError, type TtsCacheOptions } from "./cache.ts";

export interface OpenAiTtsOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  cacheDir?: string;
  dataDir?: string;
  concurrencyLimit?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const OPENAI_VOICE_DEFINITIONS: Array<{
  id: string;
  name: string;
  gender?: "female" | "male" | "neutral";
}> = [
  { id: "alloy", name: "Alloy", gender: "neutral" },
  { id: "ash", name: "Ash", gender: "male" },
  { id: "coral", name: "Coral", gender: "female" },
  { id: "echo", name: "Echo", gender: "male" },
  { id: "fable", name: "Fable", gender: "neutral" },
  { id: "onyx", name: "Onyx", gender: "male" },
  { id: "nova", name: "Nova", gender: "female" },
  { id: "sage", name: "Sage", gender: "neutral" },
  { id: "shimmer", name: "Shimmer", gender: "female" },
];

export class OpenAiTtsProvider implements TtsProvider {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  private readonly fetchFn: typeof fetch;
  readonly cache: TtsCache;

  constructor(options: OpenAiTtsOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAiTtsProvider requires apiKey");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = options.model ?? "tts-1";
    this.fetchFn = options.fetch ?? globalThis.fetch;
    const cacheOpts: TtsCacheOptions = {
      cacheDir: options.cacheDir,
      dataDir: options.dataDir,
      concurrencyLimit: options.concurrencyLimit,
      maxRetries: options.maxRetries,
      initialBackoffMs: options.initialBackoffMs,
      sleep: options.sleep,
    };
    this.cache = new TtsCache(cacheOpts);
  }

  async voices(lang: Lang): Promise<Voice[]> {
    return OPENAI_VOICE_DEFINITIONS.map((v) => ({
      ...v,
      lang,
    }));
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    return this.cache.synthesizeWithCache("openai", request, async () => {
      const url = `${this.baseUrl}/audio/speech`;
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "podcast-studio",
        },
        body: JSON.stringify({
          model: this.model,
          input: request.text,
          voice: request.voice,
          speed: request.rate,
          response_format: "wav",
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let message = text;
        try {
          const json = JSON.parse(text) as { error?: { message?: string } };
          if (json.error?.message) {
            message = json.error.message;
          }
        } catch {
          // Keep raw text
        }
        throw new TtsHttpError(
          response.status,
          `OpenAI TTS failed (${response.status} ${response.statusText}): ${message}`,
        );
      }

      const audio = Buffer.from(await response.arrayBuffer());
      return {
        audio,
        chars: countChars(request.text),
      };
    });
  }
}
