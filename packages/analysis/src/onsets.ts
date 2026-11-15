// Span-refined onsets: exact timestamps for when each service started misbehaving.
//
// Metric onsets are only known to one tick. Sampled spans carry exact times, so for every
// service and the DB pool this finds the first PERSISTENT span-level exceedance (see spanOnset):
//   <service>  a server span was slow (duration > threshold; exceeds at start + threshold) or
//              failed (exceeds when the error was returned, i.e. at its end). Both count because
//              in an overload many requests fail fast instead of being slow.
//   db         a db.pool.acquire span found the pool full (in_use ≥ capacity at request time).
// Thresholds come from the baseline window per (service, operation):
//   max(factor × baseline p99, baseline p99 + floor).

import { SPAN_ATTRS, type Span } from '@tracepilot/schema';
import { DB_NODE } from './graph.ts';
import { spanOnset, type OnsetEstimate } from './precedence.ts';
import { inWindow, type Window } from './series.ts';
import { quantile } from './stats.ts';
import { durationUs, spanKind } from './traces.ts';

export interface RefineOptions {
  baseline: Window;
  /** Only spans starting at or after this are searched (e.g. the baseline end). */
  fromUs: number;
  /** Span-level persistence duration; use the metric tick. */
  windowUs: number;
  /** Default 2. */
  thresholdFactor?: number;
  /** Default 10 ms. */
  thresholdFloorUs?: number;
  /** Minimum baseline spans per operation to derive a threshold. Default 20. */
  minBaselineSpans?: number;
}

export interface RefinedOnsets {
  /** service → earliest onset over its operations (db: pool observed full). */
  onsets: Record<string, OnsetEstimate>;
  /** `service/operation` → onset. */
  byOperation: Record<string, OnsetEstimate>;
  /** Thresholds used, per `service/operation`. */
  thresholdsUs: Record<string, number>;
}

export function refineOnsetsFromSpans(spans: readonly Span[], opts: RefineOptions): RefinedOnsets {
  const factor = opts.thresholdFactor ?? 2;
  const floor = opts.thresholdFloorUs ?? 10_000;
  const minBase = opts.minBaselineSpans ?? 20;
  const onsets: Record<string, OnsetEstimate> = {};
  const byOperation: Record<string, OnsetEstimate> = {};
  const thresholdsUs: Record<string, number> = {};

  const byOp = new Map<string, Span[]>();
  const acquires: Span[] = [];
  for (const s of spans) {
    const kind = spanKind(s);
    if (kind === 'pool_acquire') acquires.push(s);
    if (kind !== 'server') continue;
    const key = `${s.service}/${s.name}`;
    const list = byOp.get(key);
    if (list === undefined) byOp.set(key, [s]);
    else list.push(s);
  }

  for (const [key, list] of [...byOp.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const base = list
      .filter((s) => inWindow(s.startUs, opts.baseline) && s.status === 'ok')
      .map(durationUs);
    if (base.length < minBase) continue;
    const p99 = quantile(base, 0.99);
    const thr = Math.round(Math.max(factor * p99, p99 + floor));
    thresholdsUs[key] = thr;
    const service = key.slice(0, key.indexOf('/'));
    const found = spanOnset({
      label: `${key} slow or failing`,
      service,
      candidates: list,
      exceedAt: (s) => {
        const slow = durationUs(s) > thr ? s.startUs + thr : null;
        const failed = s.status !== 'ok' ? s.endUs : null;
        return slow === null ? failed : failed === null ? slow : Math.min(slow, failed);
      },
      fromUs: opts.fromUs,
      windowUs: opts.windowUs,
    });
    if (found !== null) byOperation[key] = found;
    const cur = onsets[service];
    if (found !== null && (cur === undefined || found.ts < cur.ts)) onsets[service] = found;
  }

  const full = spanOnset({
    label: `${DB_NODE} connection pool observed full`,
    service: DB_NODE,
    candidates: acquires,
    exceedAt: (s) => {
      const inUse = s.attributes[SPAN_ATTRS.poolInUseAtAcquire];
      const cap = s.attributes[SPAN_ATTRS.poolCapacity];
      return typeof inUse === 'number' && typeof cap === 'number' && inUse >= cap
        ? s.startUs
        : null;
    },
    fromUs: opts.fromUs,
    windowUs: opts.windowUs,
  });
  if (full !== null) onsets[DB_NODE] = full;
  return { onsets, byOperation, thresholdsUs };
}
