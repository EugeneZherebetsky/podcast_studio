import type { Lang } from "shared";

/** A voice a TTS provider can speak with; `id` is what `synthesize` takes as `voice`. */
export interface Voice {
  id: string;
  /** Human-readable name for the settings UI. */
  name: string;
  /** Language the voice speaks, as a BCP-47 tag (e.g. "hu" or "hu-HU"). */
  lang: Lang;
  gender?: "female" | "male" | "neutral";
}

export interface SynthesizeRequest {
  /** Exactly what is spoken. */
  text: string;
  lang: Lang;
  /** A `Voice.id` of this provider. */
  voice: string;
  /** Speaking rate, 1 = the voice's normal speed (segments use 0.7–1.1). */
  rate: number;
}

export interface SynthesizeResult {
  /** A mono 24 kHz 16-bit PCM WAV file. Durations are measured from it, never estimated. */
  wavPath: string;
  /** Characters billed for this call, for the cost guard. */
  chars: number;
}

export interface TtsProvider {
  voices(lang: Lang): Promise<Voice[]>;
  synthesize(request: SynthesizeRequest): Promise<SynthesizeResult>;
}

/** Counts Unicode code points in text. */
export function countChars(text: string): number {
  return Array.from(text).length;
}

