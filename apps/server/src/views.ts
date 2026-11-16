// What the UI shows, computed from TELEMETRY only (the store, through the agents' ToolContext and
// the analysis library). Nothing here reads the simulator recording or eval ground truth.

import {
  analyzeSaturation,
  buildTimeline,
  inWindow,
  quantile,
  type Window,
} from '@tracepilot/analysis';
import type { ToolContext } from '@tracepilot/agents';
import type { MetricName, Span } from '@tracepilot/schema';

export type Health = 'ok' | 'degraded' | 'failing';

const median = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : quantile(xs, 0.5);

function seriesValues(ctx: ToolContext, service: string, metric: MetricName, w: Window): number[] {
  const s = ctx.series.find((x) => x.service === service && x.name === metric);
  return s === undefined ? [] : s.points.filter((p) => inWindow(p.ts, w)).map((p) => p.value);
}

/** The three headline figures, from metrics: p99 latency, failed requests, successful req/s. */
export interface Headline {
  p99Us: number | null;
  /** Failed requests in the window: Σ error_rate × request_rate × tick. */
  failures: number;
  /** Median successful requests per second. */
  throughputPerS: number | null;
}

export function headline(ctx: ToolContext, services: readonly string[], w: Window): Headline {
  const tickS = ctx.tick / 1_000_000;
  let failures = 0;
  const p99s: number[] = [];
  const goodByTs = new Map<number, number>();
  for (const svc of services) {
    const rate = ctx.series.find((x) => x.service === svc && x.name === 'request_rate');
    const err = ctx.series.find((x) => x.service === svc && x.name === 'error_rate');
    const errAt = new Map(
      (err === undefined ? [] : err.points.filter((p) => inWindow(p.ts, w))).map((p) => [
        p.ts,
        p.value,
      ]),
    );
    for (const p of rate === undefined ? [] : rate.points.filter((p) => inWindow(p.ts, w))) {
      const e = errAt.get(p.ts) ?? 0;
      failures += e * p.value * tickS;
      goodByTs.set(p.ts, (goodByTs.get(p.ts) ?? 0) + p.value * (1 - e));
    }
    p99s.push(...seriesValues(ctx, svc, 'latency_p99', w));
  }
  return {
    p99Us: median(p99s),
    failures: Math.round(failures),
    throughputPerS: median([...goodByTs.values()]),
  };
}

export interface ServiceHealth {
  service: string;
  kind: 'service' | 'database' | 'external';
  health: Health;
  errorRate: number | null;
  p99Us: number | null;
  baselineP99Us: number | null;
}

/**
 * Health of each node in the incident window, from its own metrics: failing at ≥ 5 % errors,
 * degraded at ≥ 1 % errors or p99 ≥ 3 × baseline; the database by its connection pool (saturated
 * or busy = degraded).
 */
export function serviceHealth(ctx: ToolContext): ServiceHealth[] {
  const { baseline, incident } = ctx.windows;
  const pools = analyzeSaturation(ctx.metrics, ctx.spans, { baseline, window: incident });
  return ctx.graph.nodes.map((n) => {
    if (n.kind === 'database') {
      const pressed = pools.some(
        (r) => r.service === n.service && (r.status === 'saturated' || r.status === 'busy'),
      );
      return {
        service: n.service,
        kind: n.kind,
        health: pressed ? 'degraded' : 'ok',
        errorRate: null,
        p99Us: null,
        baselineP99Us: null,
      };
    }
    const errorRate = median(seriesValues(ctx, n.service, 'error_rate', incident));
    const p99Us = median(seriesValues(ctx, n.service, 'latency_p99', incident));
    const baselineP99Us = median(seriesValues(ctx, n.service, 'latency_p99', baseline));
    const slow =
      p99Us !== null && baselineP99Us !== null && baselineP99Us > 0 && p99Us >= 3 * baselineP99Us;
    const health: Health =
      errorRate !== null && errorRate >= 0.05
        ? 'failing'
        : (errorRate ?? 0) >= 0.01 || slow
          ? 'degraded'
          : 'ok';
    return { service: n.service, kind: n.kind, health, errorRate, p99Us, baselineP99Us };
  });
}

export function overview(ctx: ToolContext) {
  const { baseline, incident } = ctx.windows;
  const entry = ctx.graph.entryServices;
  return {
    incident: ctx.incident,
    symptom: ctx.inferred?.symptom ?? null,
    windows: { baseline, incident },
    entryServices: entry,
    headline: {
      baseline: headline(ctx, entry, baseline),
      incident: headline(ctx, entry, incident),
    },
    services: serviceHealth(ctx),
    edges: ctx.graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      callCount: e.callCount,
      errorCount: e.errorCount,
    })),
    changes: ctx.changes,
  };
}

export function timeline(ctx: ToolContext) {
  return {
    windows: { baseline: ctx.windows.baseline, incident: ctx.windows.incident },
    entries: buildTimeline({
      changes: ctx.changes,
      podEvents: ctx.podEvents,
      anomalies: ctx.anomalies.anomalies,
      logBursts: ctx.logBursts,
    }),
    affected: serviceHealth(ctx)
      .filter((s) => s.health !== 'ok')
      .map((s) => s.service),
  };
}

const SERVICE_METRICS: readonly MetricName[] = [
  'latency_p99',
  'latency_p50',
  'error_rate',
  'request_rate',
  'in_flight',
  'queue_depth',
  'pool_in_use',
  'pool_wait_queue',
  'db_active_queries',
  'replicas_ready',
  'pod_restarts',
  'memory_working_set',
  'cache_hit_ratio',
];

export interface TraceSummary {
  traceId: string;
  startUs: number;
  durationUs: number;
  status: Span['status'];
  root: string;
}

/** One service: its metric series and the slowest sampled traces through it in the incident window. */
export function serviceDetail(ctx: ToolContext, service: string) {
  const metrics = ctx.series
    .filter((s) => s.service === service && SERVICE_METRICS.includes(s.name))
    .map((s) => ({
      metric: s.name,
      unit: s.unit,
      points: s.points.map((p) => [p.ts, p.value] as const),
    }));
  const { incident } = ctx.windows;
  const spans = ctx.store.getSpans(ctx.incidentId, {
    service,
    fromUs: incident.fromUs,
    toUs: incident.toUs,
  });
  const byTrace = new Map<string, number>();
  for (const s of spans)
    byTrace.set(s.traceId, Math.max(byTrace.get(s.traceId) ?? 0, s.endUs - s.startUs));
  const slowest = [...byTrace.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12);
  const traces: TraceSummary[] = slowest.flatMap(([traceId]) => {
    const all = ctx.store.getTrace(ctx.incidentId, traceId);
    const root = all.find((s) => s.parentSpanId === null);
    return root === undefined
      ? []
      : [
          {
            traceId,
            startUs: root.startUs,
            durationUs: root.endUs - root.startUs,
            status: root.status,
            root: `${root.service} ${root.name}`,
          },
        ];
  });
  return { service, metrics, traces };
}
