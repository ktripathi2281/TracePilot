// Display formatting only. Values are rendered, never computed.

/** Virtual time as T+m:ss. */
export function fmtT(us: number, ms = false): string {
  const min = Math.floor(us / 60_000_000);
  const sec = Math.floor((us % 60_000_000) / 1_000_000);
  const base = `T+${String(min)}:${String(sec).padStart(2, '0')}`;
  return ms ? `${base}.${String(Math.floor((us % 1_000_000) / 1_000)).padStart(3, '0')}` : base;
}

export function fmtDur(us: number | null | undefined): string {
  if (us === null || us === undefined) return '—';
  if (Math.abs(us) >= 1_000_000) return `${(us / 1_000_000).toFixed(2)} s`;
  if (Math.abs(us) >= 1_000) return `${(us / 1_000).toFixed(0)} ms`;
  return `${String(Math.round(us))} µs`;
}

export const fmtPct = (x: number | null | undefined): string =>
  x === null || x === undefined ? '—' : `${(100 * x).toFixed(1)}%`;

export const fmtRate = (x: number | null | undefined): string =>
  x === null || x === undefined ? '—' : `${x.toFixed(1)}/s`;

export const fmtCount = (x: number | null | undefined): string =>
  x === null || x === undefined ? '—' : Math.round(x).toLocaleString('en-US');

export const fmtBytes = (x: number | null | undefined): string =>
  x === null || x === undefined ? '—' : `${Math.round(x / 1_048_576).toLocaleString('en-US')} MiB`;

export function fmtUnit(unit: string, v: number | null | undefined): string {
  if (unit === 'us') return fmtDur(v);
  if (unit === 'bytes') return fmtBytes(v);
  if (unit === 'ratio') return fmtPct(v);
  if (unit === 'req/s') return fmtRate(v);
  return fmtCount(v);
}

/** Shown with every replay result (must equal REPLAY_NOTICE in @tracepilot/replay; tested). */
export const REPLAY_NOTICE =
  'Simulated from a model of the system. Not a guarantee of production behavior.';

/** A knob value as a person reads it: memory limits in MiB, `...Us` knobs as durations. */
export function fmtKnobValue(target: string, value: number): string {
  if (target.endsWith('.memoryLimit')) return fmtBytes(value);
  if (target.endsWith('Us')) return fmtDur(value);
  return String(value);
}
