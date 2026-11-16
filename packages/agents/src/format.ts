// Deterministic rendering of numbers in fact statements. The LLM may only repeat these.

/** Virtual time as `T+m:ss.mmm` (minutes since telemetry start). */
export function fmtT(us: number): string {
  const min = Math.floor(us / 60_000_000);
  const sec = Math.floor((us % 60_000_000) / 1_000_000);
  const ms = Math.floor((us % 1_000_000) / 1_000);
  return `T+${String(min)}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Durations as `1.74 s` or `49.7 ms`. */
export function fmtDur(us: number): string {
  return Math.abs(us) >= 1_000_000
    ? `${(us / 1_000_000).toFixed(2)} s`
    : `${(us / 1_000).toFixed(1)} ms`;
}

export const fmtPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

export const fmtNum = (x: number): string =>
  Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000);

/** A metric value in its unit. */
export function fmtMetric(value: number, unit: string): string {
  if (unit === 'us') return fmtDur(value);
  if (unit === 'ratio') return fmtPct(value);
  if (unit === 'req/s') return `${fmtNum(value)} req/s`;
  return fmtNum(value);
}
