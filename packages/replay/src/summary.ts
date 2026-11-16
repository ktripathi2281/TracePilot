// What one simulator run looks like, computed from that run's output only (outcomes, stats and
// telemetry). Every number in a replay comparison comes from here: none from a model, none from
// the telemetry store.

import {
  analyzeSaturation,
  type ResourceSaturation,
  type SaturationStatus,
  type Window,
} from '@tracepilot/analysis';
import { US_PER_S, type MetricName } from '@tracepilot/schema';
import { percentile, type RequestOutcome, type SimResult } from '@tracepilot/sim';
import { z } from 'zod';

/** Metrics kept as time series for before/after charts (brief §7). */
export const CHART_METRICS: readonly MetricName[] = [
  'latency_p50',
  'latency_p95',
  'latency_p99',
  'error_rate',
  'request_rate',
  'in_flight',
  'queue_depth',
  'pool_in_use',
  'pool_wait_queue',
  'db_active_queries',
  'query_exec_p95',
];

export const RequestStats = z.strictObject({
  requests: z.number().int(),
  failed: z.number().int(),
  timedOut: z.number().int(),
  errorRate: z.number(),
  p50Us: z.number(),
  p95Us: z.number(),
  p99Us: z.number(),
  /** Successful requests per second. */
  goodputPerS: z.number(),
});
export type RequestStats = z.infer<typeof RequestStats>;

export const ServiceFailures = z.strictObject({
  service: z.string(),
  /** Every response of the service, from the simulator's counters (not sampled). */
  responses: z.number().int(),
  errors: z.number().int(),
  /** Requests turned away because the service's queue was full. */
  rejected: z.number().int(),
  /** Sampled spans of this service that ended in a timeout. */
  sampledTimeoutSpans: z.number().int(),
  /** First metric sample after the baseline window with error_rate above 1 %, or null. */
  firstFailingUs: z.number().nullable(),
});
export type ServiceFailures = z.infer<typeof ServiceFailures>;

export const ResourceState = z.strictObject({
  resource: z.string(),
  kind: z.string(),
  status: z.enum(['saturated', 'busy', 'ok', 'unknown-capacity']),
  capacity: z.number().nullable(),
  utilizationMean: z.number().nullable(),
  queueMean: z.number(),
  queueMax: z.number(),
  saturatedShare: z.number(),
});
export type ResourceState = z.infer<typeof ResourceState>;

export const Series = z.strictObject({
  service: z.string(),
  metric: z.string(),
  /** [ts µs, value] */
  points: z.array(z.tuple([z.number(), z.number()])),
});
export type Series = z.infer<typeof Series>;

export const RunSummary = z.strictObject({
  telemetryHash: z.string(),
  /** Requests entering the system that FINISHED in the incident window, all types together. */
  incident: RequestStats,
  byType: z.record(z.string(), RequestStats),
  /** Time in the incident window during which the user-facing symptom held (see degradedBuckets). */
  degradedUs: z.number(),
  firstDegradedUs: z.number().nullable(),
  pool: z.strictObject({
    acquireTimeouts: z.number().int(),
    totalAcquireWaitUs: z.number(),
    totalHoldUs: z.number(),
  }),
  db: z.strictObject({ totalQueueWaitUs: z.number(), totalExecUs: z.number() }),
  failures: z.array(ServiceFailures),
  /** The saturation analyzer (Phase 2) on this run's telemetry, incident window. */
  saturation: z.array(ResourceState),
  series: z.array(Series),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** When the user-facing symptom is considered present in a metric bucket. */
export interface SymptomThresholds {
  bucketUs: number;
  /** A bucket is degraded when more than this share of its requests failed... */
  maxErrorRate: number;
  /** ...or its p99 latency exceeds this. */
  maxP99Us: number;
}

/**
 * Thresholds from the ORIGINAL run's baseline window, applied unchanged to every replay of it:
 * errors above 1 % (or the baseline rate plus 1 point), or p99 above max(1 s, 5× baseline p99).
 */
export function symptomThresholds(
  outcomes: readonly RequestOutcome[],
  baseline: Window,
  bucketUs: number,
): SymptomThresholds {
  const base = requestStats(outcomes, baseline);
  return {
    bucketUs,
    maxErrorRate: Math.max(0.01, base.errorRate + 0.01),
    maxP99Us: Math.max(US_PER_S, 5 * base.p99Us),
  };
}

const inWin = (o: RequestOutcome, w: Window): boolean => o.endUs >= w.fromUs && o.endUs < w.toUs;

export function requestStats(
  outcomes: readonly RequestOutcome[],
  w: Window,
  type?: string,
): RequestStats {
  const sel = outcomes.filter((o) => inWin(o, w) && (type === undefined || o.type === type));
  const lat = sel.map((o) => o.endUs - o.arrivalUs);
  const failed = sel.filter((o) => o.status !== 'ok').length;
  const n = sel.length;
  const secs = (w.toUs - w.fromUs) / US_PER_S;
  return {
    requests: n,
    failed,
    timedOut: sel.filter((o) => o.status === 'timeout').length,
    errorRate: n === 0 ? 0 : failed / n,
    p50Us: n === 0 ? 0 : percentile(lat, 0.5),
    p95Us: n === 0 ? 0 : percentile(lat, 0.95),
    p99Us: n === 0 ? 0 : percentile(lat, 0.99),
    goodputPerS: (n - failed) / secs,
  };
}

/** Degraded time inside `w`: buckets whose requests breach the thresholds. */
export function degraded(
  outcomes: readonly RequestOutcome[],
  w: Window,
  t: SymptomThresholds,
): { degradedUs: number; firstDegradedUs: number | null } {
  const buckets = new Map<number, number[]>();
  const failed = new Map<number, number>();
  for (const o of outcomes) {
    if (!inWin(o, w)) continue;
    const b = Math.floor((o.endUs - w.fromUs) / t.bucketUs);
    let list = buckets.get(b);
    if (list === undefined) buckets.set(b, (list = []));
    list.push(o.endUs - o.arrivalUs);
    if (o.status !== 'ok') failed.set(b, (failed.get(b) ?? 0) + 1);
  }
  // Full buckets only: a sliver at the end of the window (the window ends 1 µs past the last
  // sample) would count as "nothing finished".
  const count = Math.floor((w.toUs - w.fromUs) / t.bucketUs);
  let degradedBuckets = 0;
  let first: number | null = null;
  for (let b = 0; b < count; b++) {
    const lat = buckets.get(b);
    // A bucket in which no request finished is degraded: nothing got through.
    const bad =
      lat === undefined ||
      (failed.get(b) ?? 0) / lat.length > t.maxErrorRate ||
      percentile(lat, 0.99) > t.maxP99Us;
    if (bad) {
      degradedBuckets++;
      first ??= w.fromUs + b * t.bucketUs;
    }
  }
  return {
    degradedUs: Math.min(degradedBuckets * t.bucketUs, w.toUs - w.fromUs),
    firstDegradedUs: first,
  };
}

function resourceState(r: ResourceSaturation): ResourceState {
  return {
    resource: r.resource,
    kind: r.kind,
    status: r.status,
    capacity: r.capacity.value,
    utilizationMean: r.utilization?.mean ?? null,
    queueMean: r.saturation.mean,
    queueMax: r.saturation.max,
    saturatedShare: r.saturatedShare,
  };
}

export interface SummaryContext {
  windows: { baseline: Window; incident: Window };
  thresholds: SymptomThresholds;
  telemetryHash: string;
}

export function summarizeRun(result: SimResult, c: SummaryContext): RunSummary {
  const { outcomes, stats, telemetry } = result;
  const { baseline, incident } = c.windows;
  const types = [...new Set(outcomes.map((o) => o.type))].sort();
  const byType: Record<string, RequestStats> = {};
  for (const t of types) byType[t] = requestStats(outcomes, incident, t);

  const timeouts = new Map<string, number>();
  for (const s of telemetry.spans)
    if (s.status === 'timeout') timeouts.set(s.service, (timeouts.get(s.service) ?? 0) + 1);
  const firstFailing = new Map<string, number>();
  for (const m of telemetry.metrics) {
    if (m.name !== 'error_rate' || m.ts <= baseline.toUs || m.value <= 0.01) continue;
    if (!firstFailing.has(m.service)) firstFailing.set(m.service, m.ts);
  }
  const failures: ServiceFailures[] = Object.entries(stats.services)
    .map(([service, s]) => ({
      service,
      responses: s.responses,
      errors: s.errors,
      rejected: s.rejected,
      sampledTimeoutSpans: timeouts.get(service) ?? 0,
      firstFailingUs: firstFailing.get(service) ?? null,
    }))
    .sort((a, b) => a.service.localeCompare(b.service));

  const series = new Map<string, Series>();
  for (const m of telemetry.metrics) {
    if (!CHART_METRICS.includes(m.name)) continue;
    const key = `${m.service}|${m.name}`;
    let s = series.get(key);
    if (s === undefined) series.set(key, (s = { service: m.service, metric: m.name, points: [] }));
    s.points.push([m.ts, m.value]);
  }

  return {
    telemetryHash: c.telemetryHash,
    incident: requestStats(outcomes, incident),
    byType,
    ...degraded(outcomes, incident, c.thresholds),
    pool: {
      acquireTimeouts: stats.pool.acquireTimeouts,
      totalAcquireWaitUs: stats.pool.totalAcquireWaitUs,
      totalHoldUs: stats.pool.totalHoldUs,
    },
    db: { totalQueueWaitUs: stats.db.totalQueueWaitUs, totalExecUs: stats.db.totalExecUs },
    failures,
    saturation: analyzeSaturation(telemetry.metrics, telemetry.spans, {
      baseline,
      window: incident,
    }).map(resourceState),
    series: [...series.values()].sort(
      (a, b) => a.service.localeCompare(b.service) || a.metric.localeCompare(b.metric),
    ),
  };
}

export const PRESSURE: readonly SaturationStatus[] = ['saturated', 'busy'];
