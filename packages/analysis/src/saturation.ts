// Saturation analysis, USE method (brief §4.5): utilization, saturation, errors per resource.
//
// Resources and their signals, all from telemetry:
//   db.pool           utilization = pool_in_use / pool_capacity    saturation = pool_wait_queue
//                     errors = sampled db.pool.acquire spans that timed out
//   db.executor       utilization = db_active_queries / capacity*  saturation = db queue_depth
//   <svc>.workers     utilization = in_flight / capacity*          saturation = queue_depth
//                     errors = mean error_rate
// * Worker and executor limits are not exported as metrics. When a queue exists at the same
//   instant, every unit was busy, so the capacity is INFERRED as the highest concurrency seen
//   while queueing in the analysed window. With no queueing there is no estimate and the
//   resource reports `unknown-capacity`; its queue is still analysed.
//
// A resource is `saturated` when, for at least `persistence` consecutive samples, utilization is
// ≥ 95 % AND its queue is above max(1, baseline p95): fully busy with work piling up. `busy` means
// the utilization part held without a growing queue.

import { SPAN_NAMES, type MetricName, type MetricPoint, type Span } from '@tracepilot/schema';
import { DB_NODE } from './graph.ts';
import {
  findSeries,
  inWindow,
  toSeries,
  type Series,
  type SeriesPoint,
  type Window,
} from './series.ts';
import { mean, quantile, round3 } from './stats.ts';
import { spanEvidence } from './traces.ts';

export interface SaturationOptions {
  baseline: Window;
  window: Window;
  /** Default 0.95. */
  utilizationThreshold?: number;
  /** Default 3. */
  persistence?: number;
}

export type SaturationStatus = 'saturated' | 'busy' | 'ok' | 'unknown-capacity';

export interface ResourceSaturation {
  resource: string;
  kind: 'connection-pool' | 'db-executor' | 'workers';
  service: string;
  capacity: { value: number | null; source: 'metric' | 'inferred-from-queueing' | 'unknown' };
  utilization: { mean: number; p95: number; max: number; samplesAtOrAbove: number } | null;
  saturation: { mean: number; max: number; baselineP95: number };
  errors: { count: number | null; rate: number | null };
  status: SaturationStatus;
  /** First sample of the first saturated run. */
  saturatedFromUs: number | null;
  /**
   * Fraction of the window's samples that were full with work queued. Separates a resource that
   * was exhausted for the whole window (≈ 1) from one that hit its limit in short episodes.
   */
  saturatedShare: number;
  samples: number;
  evidenceIds: string[];
}

export function analyzeSaturation(
  metrics: readonly MetricPoint[],
  spans: readonly Span[],
  opts: SaturationOptions,
): ResourceSaturation[] {
  const all = toSeries(metrics);
  const out: ResourceSaturation[] = [];
  const pool = findSeries(all, DB_NODE, 'pool_in_use');
  const poolCap = findSeries(all, DB_NODE, 'pool_capacity');
  const poolQueue = findSeries(all, DB_NODE, 'pool_wait_queue');
  if (pool !== undefined && poolQueue !== undefined) {
    const timeouts = spans.filter(
      (s) =>
        s.name === SPAN_NAMES.poolAcquire &&
        s.status === 'timeout' &&
        inWindow(s.endUs, opts.window),
    );
    out.push(
      resource(opts, {
        resource: `${DB_NODE}.pool`,
        kind: 'connection-pool',
        service: DB_NODE,
        busy: pool,
        capacity: poolCap === undefined ? { series: null } : { series: poolCap },
        queue: poolQueue,
        errors: {
          count: timeouts.length,
          rate: null,
          evidenceIds: timeouts.slice(0, 3).map(spanEvidence),
        },
      }),
    );
  }
  const active = findSeries(all, DB_NODE, 'db_active_queries');
  const dbQueue = findSeries(all, DB_NODE, 'queue_depth');
  if (active !== undefined && dbQueue !== undefined) {
    out.push(
      resource(opts, {
        resource: `${DB_NODE}.executor`,
        kind: 'db-executor',
        service: DB_NODE,
        busy: active,
        capacity: { series: null },
        queue: dbQueue,
        errors: { count: null, rate: null, evidenceIds: [] },
      }),
    );
  }
  const services = [...new Set(all.map((s) => s.service))].filter((s) => s !== DB_NODE).sort();
  for (const service of services) {
    const inFlight = findSeries(all, service, 'in_flight');
    const queue = findSeries(all, service, 'queue_depth');
    if (inFlight === undefined || queue === undefined) continue;
    const errorRate = findSeries(all, service, 'error_rate');
    const errPts = errorRate?.points.filter((p) => inWindow(p.ts, opts.window)) ?? [];
    out.push(
      resource(opts, {
        resource: `${service}.workers`,
        kind: 'workers',
        service,
        busy: inFlight,
        capacity: { series: null },
        queue,
        errors: {
          count: null,
          rate: errPts.length === 0 ? null : round3(mean(errPts.map((p) => p.value))),
          evidenceIds: errPts.length === 0 ? [] : [maxBy(errPts).evidenceId],
        },
      }),
    );
  }
  return out;
}

interface ResourceInput {
  resource: string;
  kind: ResourceSaturation['kind'];
  service: string;
  busy: Series;
  capacity: { series: Series | null };
  queue: Series;
  errors: { count: number | null; rate: number | null; evidenceIds: string[] };
}

const maxBy = (pts: readonly SeriesPoint[]): SeriesPoint =>
  pts.reduce((best, p) => (p.value > best.value ? p : best));

function resource(opts: SaturationOptions, r: ResourceInput): ResourceSaturation {
  const uT = opts.utilizationThreshold ?? 0.95;
  const persistence = opts.persistence ?? 3;
  const busy = r.busy.points.filter((p) => inWindow(p.ts, opts.window));
  const queueAt = new Map(r.queue.points.map((p) => [p.ts, p]));
  const capAt = new Map((r.capacity.series?.points ?? []).map((p) => [p.ts, p]));
  const baseQueue = r.queue.points.filter((p) => inWindow(p.ts, opts.baseline)).map((p) => p.value);
  const baselineP95 = baseQueue.length === 0 ? 0 : quantile(baseQueue, 0.95);
  const queueThreshold = Math.max(1, baselineP95);

  // Capacity: from a metric if there is one, else inferred from concurrency while queueing.
  let inferred: SeriesPoint | null = null;
  if (r.capacity.series === null) {
    for (const p of busy) {
      const q = queueAt.get(p.ts);
      if (q !== undefined && q.value > 0 && (inferred === null || p.value > inferred.value))
        inferred = p;
    }
  }
  const capOf = (ts: number): number | null =>
    r.capacity.series !== null ? (capAt.get(ts)?.value ?? null) : (inferred?.value ?? null);
  const capSource: ResourceSaturation['capacity']['source'] =
    r.capacity.series !== null
      ? 'metric'
      : inferred !== null
        ? 'inferred-from-queueing'
        : 'unknown';

  const rows = busy.map((p) => {
    const cap = capOf(p.ts);
    const q = queueAt.get(p.ts);
    return { p, q, util: cap === null || cap === 0 ? null : Math.min(1, p.value / cap) };
  });
  const utils = rows.flatMap((x) => (x.util === null ? [] : [x.util]));
  const queues = rows.flatMap((x) => (x.q === undefined ? [] : [x.q.value]));

  // Persistent runs.
  let saturatedFrom: (typeof rows)[number] | null = null;
  let busyRun = false;
  let runSat = 0;
  let runBusy = 0;
  let saturatedSamples = 0;
  for (const x of rows) {
    const full = x.util !== null && x.util >= uT;
    const piling = x.q !== undefined && x.q.value >= queueThreshold && x.q.value > 0;
    runBusy = full ? runBusy + 1 : 0;
    runSat = full && piling ? runSat + 1 : 0;
    if (full && piling) saturatedSamples++;
    if (runBusy >= persistence) busyRun = true;
    if (runSat === persistence && saturatedFrom === null) {
      saturatedFrom = rows[rows.indexOf(x) - persistence + 1] ?? null;
    }
  }
  const status: SaturationStatus =
    saturatedFrom !== null
      ? 'saturated'
      : busyRun
        ? 'busy'
        : capSource === 'unknown'
          ? 'unknown-capacity'
          : 'ok';

  const evidence = new Set<string>();
  if (saturatedFrom !== null) {
    evidence.add(saturatedFrom.p.evidenceId);
    if (saturatedFrom.q !== undefined) evidence.add(saturatedFrom.q.evidenceId);
  }
  if (busy.length > 0) evidence.add(maxBy(busy).evidenceId);
  const qPts = rows.flatMap((x) => (x.q === undefined ? [] : [x.q]));
  if (qPts.length > 0) evidence.add(maxBy(qPts).evidenceId);
  if (inferred !== null) evidence.add(inferred.evidenceId);
  for (const id of r.errors.evidenceIds) evidence.add(id);

  return {
    resource: r.resource,
    kind: r.kind,
    service: r.service,
    capacity: {
      value:
        capSource === 'metric'
          ? (r.capacity.series?.points.at(-1)?.value ?? null)
          : (inferred?.value ?? null),
      source: capSource,
    },
    utilization:
      utils.length === 0
        ? null
        : {
            mean: round3(mean(utils)),
            p95: round3(quantile(utils, 0.95)),
            max: round3(Math.max(...utils)),
            samplesAtOrAbove: utils.filter((u) => u >= uT).length,
          },
    saturation: {
      mean: queues.length === 0 ? 0 : round3(mean(queues)),
      max: queues.length === 0 ? 0 : Math.max(...queues),
      baselineP95: round3(baselineP95),
    },
    errors: { count: r.errors.count, rate: r.errors.rate },
    status,
    saturatedFromUs: saturatedFrom?.p.ts ?? null,
    saturatedShare: rows.length === 0 ? 0 : round3(saturatedSamples / rows.length),
    samples: rows.length,
    evidenceIds: [...evidence],
  };
}

/** Metric names this analyzer reads, for callers that fetch selectively. */
export const SATURATION_METRICS: readonly MetricName[] = [
  'pool_in_use',
  'pool_capacity',
  'pool_wait_queue',
  'db_active_queries',
  'queue_depth',
  'in_flight',
  'error_rate',
];
