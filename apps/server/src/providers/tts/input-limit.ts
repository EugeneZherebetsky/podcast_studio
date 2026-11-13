/** Bound the entire input before any cloud request; this is not a currency budget. */
export function checkTtsInputLimit(texts: readonly string[], limit: number): { bytes: number; characters: number } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid cloud TTS input limit");
  let bytes = 0;
  let characters = 0;
  for (const text of texts) {
    bytes += Buffer.byteLength(text, "utf8");
    characters += text.length;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(characters) || bytes > limit || characters > limit) {
      throw new Error("Cloud TTS input limit exceeded");
    }
  }
  return { bytes, characters };
}
