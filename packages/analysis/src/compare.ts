// Window comparison: the same signal in a baseline window vs another window.
//
// `compareSpanGroups` is what separates "the DB got slow" from "requests wait for connections":
// for db.query spans it compares pure EXECUTION time (duration minus DB-executor queue wait) per
// statement, separately from the queue wait.

import { SPAN_ATTRS, type Span } from '@tracepilot/schema';
import { inWindow, type Series, type Window } from './series.ts';
import { medianItems, quantile, robustStats, round3 } from './stats.ts';
import { dbExecUs, dbQueueWaitUs, durationUs, spanEvidence, spanKind } from './traces.ts';

export type Shift = 'flat' | 'up' | 'down' | 'inconclusive' | 'insufficient-data';

export interface CompareOptions {
  /**
   * Tolerance band for the ratio of medians. With a confidence interval available: `flat` when
   * the whole ~95 % interval is inside [1/tolerance, tolerance], `up`/`down` when it is wholly
   * outside, else `inconclusive`. Default 1.25.
   */
  tolerance?: number;
  /** Minimum samples per side. Default 10. */
  minSamples?: number;
}

export interface WindowStats {
  count: number;
  p50: number | null;
  p95: number | null;
  medianEvidenceIds: string[];
}

export interface Comparison {
  key: string;
  baseline: WindowStats;
  window: WindowStats;
  /** window.p50 / baseline.p50. */
  ratio: number | null;
  /** ~95 % interval for the ratio of medians; null when it cannot be computed. */
  ratioInterval: [number, number] | null;
  shift: Shift;
}

interface Sample {
  value: number;
  evidenceId: string;
}

function windowStats(samples: readonly Sample[]): WindowStats {
  if (samples.length === 0) return { count: 0, p50: null, p95: null, medianEvidenceIds: [] };
  const values = samples.map((s) => s.value);
  return {
    count: samples.length,
    p50: round3(quantile(values, 0.5)),
    p95: round3(quantile(values, 0.95)),
    medianEvidenceIds: medianItems(samples, (s) => s.value).map((s) => s.evidenceId),
  };
}

/**
 * Standard error of the median of log values: 1.2533 × robust sigma / √n (asymptotic, normal
 * approximation in log space, which suits latencies). Null if any value is not positive.
 */
function logMedianSe(samples: readonly Sample[]): number | null {
  if (samples.some((s) => s.value <= 0)) return null;
  const logs = samples.map((s) => Math.log(s.value));
  return (1.2533 * robustStats(logs).sigma) / Math.sqrt(logs.length);
}

function compare(
  key: string,
  base: readonly Sample[],
  win: readonly Sample[],
  opts: CompareOptions,
): Comparison {
  const tol = opts.tolerance ?? 1.25;
  const minSamples = opts.minSamples ?? 10;
  const b = windowStats(base);
  const w = windowStats(win);
  const ratio = b.p50 === null || w.p50 === null || b.p50 === 0 ? null : round3(w.p50 / b.p50);
  const seB = logMedianSe(base);
  const seW = logMedianSe(win);
  const half = seB === null || seW === null ? null : 2 * Math.hypot(seB, seW);
  const ratioInterval: [number, number] | null =
    ratio === null || half === null
      ? null
      : [round3(ratio * Math.exp(-half)), round3(ratio * Math.exp(half))];
  let shift: Shift;
  if (b.count < minSamples || w.count < minSamples || b.p50 === null || w.p50 === null) {
    shift = 'insufficient-data';
  } else if (b.p50 === 0) {
    shift = w.p50 === 0 ? 'flat' : 'up';
  } else if (ratio === null || ratioInterval === null) {
    const r = w.p50 / b.p50;
    shift = r > tol ? 'up' : r < 1 / tol ? 'down' : 'flat';
  } else {
    // Decide only when the whole interval is on one side of the tolerance band.
    const [lo, hi] = ratioInterval;
    shift =
      lo > tol
        ? 'up'
        : hi < 1 / tol
          ? 'down'
          : lo >= 1 / tol && hi <= tol
            ? 'flat'
            : 'inconclusive';
  }
  return { key, baseline: b, window: w, ratio, ratioInterval, shift };
}

export type SpanMeasure = 'duration' | 'db_exec' | 'db_queue';

const MEASURES: Record<SpanMeasure, (s: Span) => number> = {
  duration: durationUs,
  db_exec: dbExecUs,
  db_queue: dbQueueWaitUs,
};

export interface SpanGroupOptions extends CompareOptions {
  baseline: Window;
  window: Window;
  /** Group key per span; return null to skip the span. */
  groupBy: (s: Span) => string | null;
  measure?: SpanMeasure;
  /** Only spans with status ok. Default true: failures are cut short and skew durations. */
  okOnly?: boolean;
}

/** Compares a span measure per group between two windows (by span START time). */
export function compareSpanGroups(spans: readonly Span[], opts: SpanGroupOptions): Comparison[] {
  const measure = MEASURES[opts.measure ?? 'duration'];
  const okOnly = opts.okOnly ?? true;
  const base = new Map<string, Sample[]>();
  const win = new Map<string, Sample[]>();
  for (const s of spans) {
    if (okOnly && s.status !== 'ok') continue;
    const key = opts.groupBy(s);
    if (key === null) continue;
    const target = inWindow(s.startUs, opts.baseline)
      ? base
      : inWindow(s.startUs, opts.window)
        ? win
        : null;
    if (target === null) continue;
    const list = target.get(key) ?? [];
    list.push({ value: measure(s), evidenceId: spanEvidence(s) });
    target.set(key, list);
  }
  const keys = [...new Set([...base.keys(), ...win.keys()])].sort();
  return keys.map((k) => compare(k, base.get(k) ?? [], win.get(k) ?? [], opts));
}

export interface DbQueryProfile {
  /** Per statement: execution time only. */
  exec: Comparison[];
  /** Per statement: time queued at the DB executor. */
  dbQueue: Comparison[];
  /**
   * True when at least one statement's execution time is confidently flat and none is
   * confidently up or down. Statements with too few samples or a wide interval do not count.
   */
  execFlat: boolean;
}

/** db.query per statement: execution vs DB-queue time, baseline vs window. */
export function dbQueryProfile(
  spans: readonly Span[],
  baseline: Window,
  window: Window,
  opts: CompareOptions = {},
): DbQueryProfile {
  const groupBy = (s: Span): string | null => {
    if (spanKind(s) !== 'db_query') return null;
    const stmt = s.attributes[SPAN_ATTRS.dbStatement];
    return `${s.service}/${typeof stmt === 'string' ? stmt : s.name}`;
  };
  const exec = compareSpanGroups(spans, { ...opts, baseline, window, groupBy, measure: 'db_exec' });
  const dbQueue = compareSpanGroups(spans, {
    ...opts,
    baseline,
    window,
    groupBy,
    measure: 'db_queue',
  });
  return {
    exec,
    dbQueue,
    execFlat:
      exec.some((c) => c.shift === 'flat') &&
      !exec.some((c) => c.shift === 'up' || c.shift === 'down'),
  };
}

/** Same comparison for a metric series. */
export function compareSeries(
  series: Series,
  baseline: Window,
  window: Window,
  opts: CompareOptions = {},
): Comparison {
  const pick = (w: Window): Sample[] =>
    series.points
      .filter((p) => inWindow(p.ts, w))
      .map((p) => ({ value: p.value, evidenceId: p.evidenceId }));
  return compare(`${series.service}/${series.name}`, pick(baseline), pick(window), {
    minSamples: 3,
    ...opts,
  });
}
