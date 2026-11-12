import type { Token } from "shared";

export function segmentAt(segments: { startMs: number; endMs: number }[], positionMs: number): number {
  return segments.findIndex((segment) => positionMs >= segment.startMs && positionMs < segment.endMs);
}

export function tokenParts(text: string, tokens: Token[]): { text: string; token?: Token }[] {
  const parts: { text: string; token?: Token }[] = [];
  let cursor = 0;
  for (const token of tokens) {
    let index = text.indexOf(token.surface, cursor);
    while (index !== -1) {
      const before = text.slice(0, index).at(-1) ?? "";
      const after = text.slice(index + token.surface.length).at(0) ?? "";
      if (!/[\p{L}\p{N}\p{M}]/u.test(before) && !/[\p{L}\p{N}\p{M}]/u.test(after)) break;
      index = text.indexOf(token.surface, index + 1);
    }
    if (index === -1) continue;
    if (index > cursor) parts.push({ text: text.slice(cursor, index) });
    parts.push({ text: token.surface, token });
    cursor = index + token.surface.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
