import type { ScriptSegment } from "shared";

/** Structural checks only; they cannot establish that Hungarian or its glosses are correct. */
export function validateGradedSegments(
  segments: readonly ScriptSegment[],
  level: "A1" | "A2",
): string[] {
  const errors: string[] = [];
  const counts = new Map<string, number>();
  const targets = new Set<string>();
  const limit = level === "A1" ? 8 : 12;
  for (const segment of segments.filter((s) => s.lang.toLowerCase() === "hu")) {
    const tokens = segment.tokens ?? [];
    let rest = segment.text;
    if (!segment.translation?.trim() || tokens.some((t) => !t.gloss.trim() || !t.morphemes?.length))
      errors.push(`${segment.id}: missing translation or token annotation`);
    for (const [index, token] of tokens.entries()) {
      const separator = rest.match(/^[\s\p{P}\p{S}]*/u)?.[0] ?? "";
      rest = rest.slice(separator.length);
      if (
        (index > 0 && !separator) ||
        !rest.startsWith(token.surface) ||
        !/^[\p{L}\p{M}\p{N}]+$/u.test(token.surface)
      ) {
        rest = "\u0000";
        break;
      }
      rest = rest.slice(token.surface.length);
      const lemma = token.lemma.normalize("NFC").toLocaleLowerCase("hu");
      counts.set(lemma, (counts.get(lemma) ?? 0) + 1);
      if (token.isTarget) targets.add(lemma);
    }
    if (!tokens.length || !/^[\s\p{P}\p{S}]*$/u.test(rest))
      errors.push(`${segment.id}: tokens do not reconstruct text`);
    const words = segment.text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
    if (words.length > limit) errors.push(`${segment.id}: exceeds ${limit} words`);
  }
  for (const lemma of targets)
    if ((counts.get(lemma) ?? 0) < 3)
      errors.push(`${lemma}: target lemma must appear at least 3 times`);
  return errors;
}
