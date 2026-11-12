export function stepSpeed(value: number, direction: -1 | 1): number {
  return Math.min(30, Math.max(10, Math.round(value * 20) + direction)) / 20;
}
export function readSpeed(value: string | null): number {
  const n = Number(value);
  return value !== null && n >= 0.5 && n <= 1.5 && Number.isInteger(n * 20) ? n : 1;
}
