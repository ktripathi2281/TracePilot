// Read-only helpers over a run's output. Used by tests, the calibration script and the CLI.
// They only read telemetry and outcomes; nothing here feeds back into the simulation.

import {
  ChangeEvent,
  LogRecord,
  MetricPoint,
  PodEvent,
  Span,
  US_PER_S,
  type MetricName,
} from '@tracepilot/schema';
import type { RequestOutcome, Telemetry } from './engine.ts';
import { percentile } from './util.ts';

export interface OutcomeSummary {
  count: number;
  ratePerS: number;
  errorRate: number;
  timeoutRate: number;
  meanUs: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
}

/** Summarizes requests of one type that FINISHED in [fromUs, toUs). */
export function summarizeOutcomes(
  outcomes: readonly RequestOutcome[],
  type: string,
  fromUs: number,
  toUs: number,
): OutcomeSummary {
  const sel = outcomes.filter((o) => o.type === type && o.endUs >= fromUs && o.endUs < toUs);
  const lat = sel.map((o) => o.endUs - o.arrivalUs);
  const n = sel.length;
  const empty = n === 0;
  return {
    count: n,
    ratePerS: n / ((toUs - fromUs) / US_PER_S),
    errorRate: empty ? 0 : sel.filter((o) => o.status !== 'ok').length / n,
    timeoutRate: empty ? 0 : sel.filter((o) => o.status === 'timeout').length / n,
    meanUs: empty ? 0 : lat.reduce((a, b) => a + b, 0) / n,
    p50Us: empty ? 0 : percentile(lat, 0.5),
    p95Us: empty ? 0 : percentile(lat, 0.95),
    p99Us: empty ? 0 : percentile(lat, 0.99),
  };
}

/** Points of one metric series with ts in (fromUs, toUs], in time order. */
export function metricSeries(
  metrics: readonly MetricPoint[],
  service: string,
  name: MetricName,
  fromUs = 0,
  toUs = Number.MAX_SAFE_INTEGER,
): { ts: number; value: number }[] {
  const out: { ts: number; value: number }[] = [];
  for (const m of metrics) {
    if (m.service === service && m.name === name && m.ts > fromUs && m.ts <= toUs) {
      out.push({ ts: m.ts, value: m.value });
    }
  }
  return out;
}

export function metricMean(
  metrics: readonly MetricPoint[],
  service: string,
  name: MetricName,
  fromUs: number,
  toUs: number,
): number {
  const series = metricSeries(metrics, service, name, fromUs, toUs);
  if (series.length === 0) throw new Error(`no ${service}/${name} points in window`);
  return series.reduce((a, p) => a + p.value, 0) / series.length;
}

export function metricMax(
  metrics: readonly MetricPoint[],
  service: string,
  name: MetricName,
  fromUs: number,
  toUs: number,
): number {
  const series = metricSeries(metrics, service, name, fromUs, toUs);
  if (series.length === 0) throw new Error(`no ${service}/${name} points in window`);
  return Math.max(...series.map((p) => p.value));
}

interface Parser {
  safeParse: (x: unknown) => { success: boolean };
}

/**
 * Validates telemetry exactly like an ingestor would (brief §2): every item through its schema,
 * plus referential checks. Returns problems; empty = valid.
 */
export function findTelemetryProblems(t: Telemetry): string[] {
  const problems: string[] = [];
  const check = (kind: string, schema: Parser, items: readonly unknown[]): void => {
    let bad = 0;
    for (const item of items) if (!schema.safeParse(item).success) bad++;
    if (bad > 0) problems.push(`${String(bad)} invalid ${kind}`);
  };
  check('spans', Span, t.spans);
  check('logs', LogRecord, t.logs);
  check('metrics', MetricPoint, t.metrics);
  check('change events', ChangeEvent, t.changeEvents);
  check('pod events', PodEvent, t.podEvents);

  const spanIds = new Set<string>();
  const traceIds = new Set<string>();
  let duplicates = 0;
  for (const s of t.spans) {
    if (spanIds.has(s.spanId)) duplicates++;
    spanIds.add(s.spanId);
    traceIds.add(s.traceId);
  }
  if (duplicates > 0) problems.push(`${String(duplicates)} duplicate span ids`);
  let orphans = 0;
  for (const s of t.spans) if (s.parentSpanId !== null && !spanIds.has(s.parentSpanId)) orphans++;
  if (orphans > 0) problems.push(`${String(orphans)} spans with a missing parent`);

  const logIds = new Set(t.logs.map((l) => l.id));
  if (logIds.size !== t.logs.length) problems.push('duplicate log ids');
  const dangling = t.logs.filter((l) => l.traceId !== undefined && !traceIds.has(l.traceId)).length;
  if (dangling > 0) problems.push(`${String(dangling)} logs pointing at a missing trace`);

  const metricKeys = new Set(t.metrics.map((m) => `${m.service}|${m.name}|${String(m.ts)}`));
  if (metricKeys.size !== t.metrics.length) problems.push('duplicate (service, metric, ts) points');
  return problems;
}
