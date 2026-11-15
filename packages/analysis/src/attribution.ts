// Latency attribution (brief §4.4): where did the time of a set of requests go?
//
// Each trace's critical path is split into EXCLUSIVE categories that sum to the root latency:
//   queue_wait    waiting for a worker in a service's request queue (queue.wait)
//   pool_acquire  waiting for a DB connection (db.pool.acquire)
//   db_queue      waiting at the DB executor with a connection already held (db.query attribute)
//   query_exec    the DB executing the query (db.query minus db_queue)
//   external      calls to non-modeled peers
//   compute       a service's own time (self time of server and transaction spans)
//
// `heldConnection` is an OVERLAY, not a category: the part of the critical path during which the
// request held a pooled connection (inside a db.transaction), and what it was doing meanwhile.
// "Held while waiting in pool_acquire" is the signature of hold-and-wait.
//
// Successful and failed requests are reported separately: they fail and succeed for different
// reasons, and mixing them hides both.

import { round3, quantile } from './stats.ts';
import {
  TIME_CATEGORIES,
  criticalPath,
  durationUs,
  spanEvidence,
  type TimeCategory,
  type TraceTree,
} from './traces.ts';

export type Outcome = 'success' | 'failure';

export type CategoryTotals = Record<TimeCategory, number>;

const zeroTotals = (): CategoryTotals => ({
  queue_wait: 0,
  pool_acquire: 0,
  db_queue: 0,
  query_exec: 0,
  external: 0,
  compute: 0,
});

export interface ServiceAttribution extends CategoryTotals {
  /** Critical-path time this service spent waiting on OTHER services it called. */
  downstream: number;
}

export interface AttributionGroup {
  outcome: Outcome;
  traces: number;
  latencyUs: { p50: number; p95: number; p99: number; max: number };
  /** Summed critical-path time per category (µs) over all traces in the group. */
  totals: CategoryTotals;
  /** totals / total latency. Weighted by time: long requests count more. */
  shares: CategoryTotals;
  dominant: TimeCategory;
  heldConnection: {
    totalUs: number;
    /** Held time / total latency. */
    share: number;
    /** What the request was doing while it held a connection. */
    byCategory: CategoryTotals;
  };
  /** Per service: its own categories plus time spent in services it called. */
  byService: Record<string, ServiceAttribution>;
  /** Root spans of the slowest traces, then spans contributing most to the dominant category. */
  evidenceIds: string[];
}

export interface AttributionResult {
  groups: AttributionGroup[];
  /** Traces considered after the duration filter. */
  traces: number;
}

export interface AttributionOptions {
  /** Only traces whose root latency is at least this. Default 0. */
  minDurationUs?: number;
}

const outcomeOf = (t: TraceTree): Outcome => (t.root.status === 'ok' ? 'success' : 'failure');

export function attributeLatency(
  traces: readonly TraceTree[],
  opts: AttributionOptions = {},
): AttributionResult {
  const min = opts.minDurationUs ?? 0;
  const selected = traces.filter((t) => durationUs(t.root) >= min);
  const groups: AttributionGroup[] = [];
  for (const outcome of ['success', 'failure'] as const) {
    const ts = selected.filter((t) => outcomeOf(t) === outcome);
    if (ts.length > 0) groups.push(attributeGroup(outcome, ts));
  }
  return { groups, traces: selected.length };
}

function attributeGroup(outcome: Outcome, traces: readonly TraceTree[]): AttributionGroup {
  const totals = zeroTotals();
  const held = zeroTotals();
  const byService: Record<string, ServiceAttribution> = {};
  const contributions = new Map<string, number>(); // span evidence id → µs in its category
  const latencies: number[] = [];
  const svc = (name: string): ServiceAttribution =>
    (byService[name] ??= { ...zeroTotals(), downstream: 0 });

  for (const t of traces) {
    latencies.push(durationUs(t.root));
    for (const seg of criticalPath(t)) {
      const us = seg.endUs - seg.startUs;
      totals[seg.category] += us;
      if (seg.heldConnection) held[seg.category] += us;
      svc(seg.span.service)[seg.category] += us;
      for (const outer of new Set(seg.enclosingServices)) {
        if (outer !== seg.span.service) svc(outer).downstream += us;
      }
      const id = spanEvidence(seg.span);
      contributions.set(
        `${seg.category}|${id}`,
        (contributions.get(`${seg.category}|${id}`) ?? 0) + us,
      );
    }
  }
  const total = latencies.reduce((a, b) => a + b, 0);
  const share = (x: number): number => (total === 0 ? 0 : round3(x / total));
  const shares = zeroTotals();
  for (const c of TIME_CATEGORIES) shares[c] = share(totals[c]);
  const dominant = TIME_CATEGORIES.reduce(
    (best, c) => (totals[c] > totals[best] ? c : best),
    'compute' as TimeCategory,
  );
  const heldTotal = TIME_CATEGORIES.reduce((a, c) => a + held[c], 0);

  const slowest = [...traces].sort((a, b) => durationUs(b.root) - durationUs(a.root)).slice(0, 3);
  const topDominant = [...contributions.entries()]
    .filter(([k]) => k.startsWith(`${dominant}|`))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([k]) => k.slice(dominant.length + 1));

  return {
    outcome,
    traces: traces.length,
    latencyUs: {
      p50: Math.round(quantile(latencies, 0.5)),
      p95: Math.round(quantile(latencies, 0.95)),
      p99: Math.round(quantile(latencies, 0.99)),
      max: Math.max(...latencies),
    },
    totals,
    shares,
    dominant,
    heldConnection: { totalUs: heldTotal, share: share(heldTotal), byCategory: held },
    byService,
    evidenceIds: [...new Set([...slowest.map((t) => spanEvidence(t.root)), ...topDominant])],
  };
}
