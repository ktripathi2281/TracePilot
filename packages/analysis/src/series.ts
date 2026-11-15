import {
  METRIC_UNITS,
  metricEvidenceId,
  type MetricName,
  type MetricPoint,
  type MetricUnit,
} from '@tracepilot/schema';

/** Half-open time window [fromUs, toUs). */
export interface Window {
  fromUs: number;
  toUs: number;
}

export const inWindow = (ts: number, w: Window): boolean => ts >= w.fromUs && ts < w.toUs;

export interface SeriesPoint {
  ts: number;
  value: number;
  /** `mt_<service>_<metric>_<ts>`: the evidence ID of this sample. */
  evidenceId: string;
}

export interface Series {
  service: string;
  name: MetricName;
  unit: MetricUnit;
  /** Time-ordered. */
  points: SeriesPoint[];
}

/** Groups metric points into series, ordered by service then metric name. */
export function toSeries(metrics: readonly MetricPoint[]): Series[] {
  const byKey = new Map<string, Series>();
  for (const m of metrics) {
    const key = `${m.service}|${m.name}`;
    let s = byKey.get(key);
    if (s === undefined) {
      s = { service: m.service, name: m.name, unit: METRIC_UNITS[m.name], points: [] };
      byKey.set(key, s);
    }
    s.points.push({
      ts: m.ts,
      value: m.value,
      evidenceId: metricEvidenceId(m.service, m.name, m.ts),
    });
  }
  const all = [...byKey.values()];
  for (const s of all) s.points.sort((a, b) => a.ts - b.ts);
  return all.sort((a, b) =>
    a.service === b.service ? (a.name < b.name ? -1 : 1) : a.service < b.service ? -1 : 1,
  );
}

export function findSeries(
  all: readonly Series[],
  service: string,
  name: MetricName,
): Series | undefined {
  return all.find((s) => s.service === service && s.name === name);
}

/** Most common gap between consecutive samples across all series (the metric tick). */
export function inferTickUs(all: readonly Series[]): number {
  const counts = new Map<number, number>();
  for (const s of all) {
    for (let i = 1; i < s.points.length; i++) {
      const gap = (s.points[i] as SeriesPoint).ts - (s.points[i - 1] as SeriesPoint).ts;
      if (gap > 0) counts.set(gap, (counts.get(gap) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = 0;
  for (const [gap, count] of counts) {
    if (count > bestCount || (count === bestCount && gap < best)) {
      best = gap;
      bestCount = count;
    }
  }
  if (best === 0) throw new Error('cannot infer the metric interval from fewer than two samples');
  return best;
}

/**
 * Joins two series on timestamp: returns pairs present in both, time-ordered. Used for ratios
 * such as pool_in_use / pool_capacity.
 */
export function joinSeries(a: Series, b: Series): { ts: number; a: SeriesPoint; b: SeriesPoint }[] {
  const byTs = new Map(b.points.map((p) => [p.ts, p]));
  const out: { ts: number; a: SeriesPoint; b: SeriesPoint }[] = [];
  for (const p of a.points) {
    const q = byTs.get(p.ts);
    if (q !== undefined) out.push({ ts: p.ts, a: p, b: q });
  }
  return out;
}
