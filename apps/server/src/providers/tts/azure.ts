import type { Lang } from "shared";
import {
  countChars,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TtsProvider,
  type Voice,
} from "./interface.ts";
import { TtsCache, TtsHttpError, type TtsCacheOptions } from "./cache.ts";

export interface AzureTtsOptions {
  subscriptionKey: string;
  region?: string;
  fetch?: typeof fetch;
  cacheDir?: string;
  dataDir?: string;
  concurrencyLimit?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const KNOWN_AZURE_VOICES: Voice[] = [
  { id: "hu-HU-NoemiNeural", name: "Noémi", lang: "hu-HU", gender: "female" },
  { id: "hu-HU-TamasNeural", name: "Tamás", lang: "hu-HU", gender: "male" },
  { id: "en-US-JennyNeural", name: "Jenny", lang: "en-US", gender: "female" },
  { id: "en-US-GuyNeural", name: "Guy", lang: "en-US", gender: "male" },
  { id: "en-US-AriaNeural", name: "Aria", lang: "en-US", gender: "female" },
  { id: "en-US-DavisNeural", name: "Davis", lang: "en-US", gender: "male" },
];

interface AzureVoiceRaw {
  Name?: string;
  DisplayName?: string;
  LocalName?: string;
  ShortName: string;
  Gender?: string;
  Locale: string;
}

/** Escapes XML special characters for inclusion in SSML text. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildAzureSsml(request: SynthesizeRequest): string {
  const escapedText = escapeXml(request.text);
  return `<speak version="1.0" xml:lang="${request.lang}"><voice name="${request.voice}"><prosody rate="${request.rate}">${escapedText}</prosody></voice></speak>`;
}

function matchesLang(voiceLang: string, targetLang: string): boolean {
  const vNorm = voiceLang.toLowerCase();
  const tNorm = targetLang.toLowerCase();
  const tPrimary = tNorm.split("-")[0]!;
  return vNorm === tNorm || vNorm.startsWith(`${tPrimary}-`) || vNorm === tPrimary;
}

export class AzureTtsProvider implements TtsProvider {
  readonly subscriptionKey: string;
  readonly region: string;
  private readonly fetchFn: typeof fetch;
  readonly cache: TtsCache;

  constructor(private readonly options: AzureTtsOptions) {
    if (!options.subscriptionKey) {
      throw new Error("AzureTtsProvider requires subscriptionKey");
    }
    this.subscriptionKey = options.subscriptionKey;
    this.region = options.region ?? "westeurope";
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

  forRun(dir: string): TtsProvider {
    return new AzureTtsProvider({ ...this.options, cacheDir: dir });
  }

  async voices(lang: Lang): Promise<Voice[]> {
    try {
      const url = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
          "User-Agent": "podcast-studio",
        },
      });

      if (!response.ok) {
        throw new Error(`voices/list responded with ${response.status}`);
      }

      const list = (await response.json()) as AzureVoiceRaw[];
      const mapped: Voice[] = list.map((item) => {
        let gender: "female" | "male" | "neutral" | undefined;
        const g = item.Gender?.toLowerCase();
        if (g === "female" || g === "male" || g === "neutral") {
          gender = g;
        }
        return {
          id: item.ShortName,
          name: item.DisplayName || item.LocalName || item.ShortName,
          lang: item.Locale,
          gender,
        };
      });

      return mapped.filter((v) => matchesLang(v.lang, lang));
    } catch {
      // Fallback to known offline voices filtered by lang
      return KNOWN_AZURE_VOICES.filter((v) => matchesLang(v.lang, lang));
    }
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    return this.cache.synthesizeWithCache("azure", request, async () => {
      const ssml = buildAzureSsml(request);
      const url = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;

      const response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
          "User-Agent": "podcast-studio",
        },
        body: ssml,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new TtsHttpError(
          response.status,
          `Azure Speech TTS failed (${response.status} ${response.statusText}): ${text}`,
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
