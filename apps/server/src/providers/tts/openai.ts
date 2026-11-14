import type { Lang } from "shared";
import {
  countChars,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TtsProvider,
  type Voice,
} from "./interface.ts";
import { TtsCache, TtsHttpError, type TtsCacheOptions } from "./cache.ts";
import { CloudTtsBillingUncertain, ExternalWorkUncertain } from "../../safe-generation-error.ts";

export interface OpenAiTtsOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
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

  constructor(private readonly options: OpenAiTtsOptions) {
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

  forRun(dir: string, signal?: AbortSignal): TtsProvider {
    return new OpenAiTtsProvider({ ...this.options, cacheDir: dir, signal });
  }

  async voices(lang: Lang): Promise<Voice[]> {
    return OPENAI_VOICE_DEFINITIONS.map((v) => ({
      ...v,
      lang,
    }));
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    let dispatched = false;
    let guardError: unknown;
    let guardFailed = false;
    const guarded = { ...request, assertContinue: () => { try { request.assertContinue?.(); } catch (error) { guardFailed = true; guardError = error; throw error; } } };
    return this.cache.synthesizeWithCache("openai", guarded, async () => {
      const url = `${this.baseUrl}/audio/speech`;
      dispatched = true;
      const response = await this.fetchFn(url, {
        method: "POST",
        redirect: "error",
        signal: this.options.signal,
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
        throw new TtsHttpError(response.status, `OpenAI TTS failed (${response.status})`);
      }

      const audio = Buffer.from(await response.arrayBuffer());
      return {
        audio,
        chars: countChars(request.text),
      };
    }).catch((error: unknown) => {
      if (error instanceof ExternalWorkUncertain || (guardFailed && error === guardError)) throw error;
      if (dispatched && !(error instanceof TtsHttpError && error.status >= 400 && error.status < 500)) {
        throw new ExternalWorkUncertain(new CloudTtsBillingUncertain(error instanceof Error && error.name === "AbortError"));
      }
      if (error instanceof TtsHttpError && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
        throw new TtsHttpError(error.status, `OpenAI TTS failed (${error.status})`);
      }
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        const safe = new Error(error.name === "AbortError" ? "TTS cancelled" : "TTS timed out");
        safe.name = error.name;
        throw safe;
      }
      throw new Error("OpenAI TTS failed");
    });
  }
}
