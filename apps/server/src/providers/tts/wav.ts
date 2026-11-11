// The audio format every TTS provider hands to the pipeline: mono, 24 kHz, 16-bit PCM WAV.
export const WAV_SAMPLE_RATE = 24_000;
export const WAV_CHANNELS = 1;
export const WAV_BITS_PER_SAMPLE = 16;
/** Size of the canonical RIFF/WAVE header written by `encodeWav`. */
export const WAV_HEADER_BYTES = 44;

/** Wraps 16-bit samples in a canonical 44-byte PCM WAV header (mono, 24 kHz). */
export function encodeWav(samples: Int16Array): Buffer {
  const bytesPerSample = WAV_BITS_PER_SAMPLE / 8;
  const blockAlign = WAV_CHANNELS * bytesPerSample;
  const dataBytes = samples.length * bytesPerSample;
  const wav = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16); // size of the fmt chunk
  wav.writeUInt16LE(1, 20); // format 1 = integer PCM
  wav.writeUInt16LE(WAV_CHANNELS, 22);
  wav.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  wav.writeUInt32LE(WAV_SAMPLE_RATE * blockAlign, 28); // byte rate
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(WAV_BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    wav.writeInt16LE(samples[i]!, WAV_HEADER_BYTES + i * bytesPerSample);
  }
  return wav;
}

/** A sine tone at half of full scale, starting at phase 0. */
export function sineTone(frequencyHz: number, sampleCount: number): Int16Array {
  const samples = new Int16Array(sampleCount);
  const step = (2 * Math.PI * frequencyHz) / WAV_SAMPLE_RATE;
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = Math.round(Math.sin(step * i) * 0.5 * 32767);
  }
  return samples;
}
