// Hold-and-wait analyzer.
//
// A pooled connection can be busy for three reasons: the DB is executing on it, it is queued at
// the DB executor, or the holder is doing something else while keeping it (e.g. calling another
// service inside a transaction). The third kind, IDLE-HELD connections, is invisible in DB
// metrics: the DB looks quiet while the pool is exhausted.
//
// Two independent views:
// - Metrics: idle-held = pool_in_use − db_active_queries − db queue_depth, per sample.
// - Spans: for every db.transaction, how much of its hold time was spent while its own
//   descendants waited in db.pool.acquire for ANOTHER connection from the same pool. That is
//   hold-and-wait in the strict sense: holding one unit of a resource while waiting for more.
//
// `detected` requires all three: the pool is saturated, most in-use connections are idle-held,
// and transactions spend most of their hold time waiting for further connections.

import type { MetricPoint } from '@tracepilot/schema';
import { DB_NODE } from './graph.ts';
import { findSeries, inWindow, joinSeries, toSeries, type Window } from './series.ts';
import { medianItems, quantile, round3 } from './stats.ts';
import {
  descendants,
  durationUs,
  spanEvidence,
  spanKind,
  unionLength,
  type TraceTree,
} from './traces.ts';

export interface HoldWaitThresholds {
  /** Median pool utilization at or above which the pool counts as saturated. Default 0.95. */
  saturatedUtilization?: number;
  /** Median idle-held fraction of in-use connections. Default 0.5. */
  idleHeldFraction?: number;
  /** Fraction of transaction hold time spent waiting for further connections. Default 0.5. */
  nestedWaitShare?: number;
}

export interface HoldWaitWindowResult {
  window: Window;
  pool: {
    samples: number;
    medianInUse: number | null;
    medianCapacity: number | null;
    medianUtilization: number | null;
    medianDbActive: number | null;
    /** Median over samples of idle-held / in-use. */
    medianIdleHeldFraction: number | null;
    evidenceIds: string[];
  };
  transactions: {
    count: number;
    holdP50Us: number | null;
    holdP95Us: number | null;
    /** Σ(time descendants waited for another connection) / Σ(hold time). */
    nestedWaitShare: number | null;
    /** Services holding connections in transactions, by total hold time. */
    holders: { service: string; holdUs: number }[];
    /** Services whose acquires waited inside someone else's held connection. */
    waiters: { service: string; waitUs: number }[];
    evidenceIds: string[];
  };
  detected: boolean;
  /** Which criteria held, in plain words. */
  criteria: { name: string; met: boolean; value: number | null; threshold: number }[];
}

export function analyzeHoldAndWait(
  metrics: readonly MetricPoint[],
  traces: readonly TraceTree[],
  window: Window,
  thresholds: HoldWaitThresholds = {},
): HoldWaitWindowResult {
  const satT = thresholds.saturatedUtilization ?? 0.95;
  const idleT = thresholds.idleHeldFraction ?? 0.5;
  const nestedT = thresholds.nestedWaitShare ?? 0.5;

  // ---- Metrics view ----
  const all = toSeries(metrics.filter((m) => m.service === DB_NODE && inWindow(m.ts, window)));
  const inUse = findSeries(all, DB_NODE, 'pool_in_use');
  const cap = findSeries(all, DB_NODE, 'pool_capacity');
  const active = findSeries(all, DB_NODE, 'db_active_queries');
  const queued = findSeries(all, DB_NODE, 'queue_depth');
  const queuedAt = new Map((queued?.points ?? []).map((p) => [p.ts, p.value]));
  const rows =
    inUse === undefined || cap === undefined || active === undefined
      ? []
      : joinSeries(inUse, cap).flatMap(({ ts, a, b }) => {
          const act = active.points.find((p) => p.ts === ts);
          if (act === undefined) return [];
          const idle = Math.max(0, a.value - act.value - (queuedAt.get(ts) ?? 0));
          return [
            {
              ts,
              inUse: a,
              cap: b,
              act,
              util: b.value > 0 ? a.value / b.value : 0,
              idleFrac: a.value > 0 ? idle / a.value : 0,
            },
          ];
        });
  const med = (xs: number[]): number | null => (xs.length === 0 ? null : round3(quantile(xs, 0.5)));
  const medianUtilization = med(rows.map((r) => r.util));
  const medianIdle = med(rows.map((r) => r.idleFrac));
  const poolEvidence = [
    ...medianItems(rows, (r) => r.util).flatMap((r) => [r.inUse.evidenceId, r.cap.evidenceId]),
    ...medianItems(rows, (r) => r.idleFrac).map((r) => r.act.evidenceId),
  ];

  // ---- Span view ----
  let holdTotal = 0;
  let nestedTotal = 0;
  const holds: number[] = [];
  const holders = new Map<string, number>();
  const waiters = new Map<string, number>();
  const txEvidence: { id: string; nested: number }[] = [];
  for (const t of traces) {
    for (const tx of t.spans) {
      if (spanKind(tx) !== 'db_transaction' || !inWindow(tx.startUs, window)) continue;
      const hold = durationUs(tx);
      const nestedAcquires = descendants(t, tx).filter((s) => spanKind(s) === 'pool_acquire');
      const nested = unionLength(
        nestedAcquires.map((s): [number, number] => [s.startUs, s.endUs]),
        tx.startUs,
        tx.endUs,
      );
      holds.push(hold);
      holdTotal += hold;
      nestedTotal += nested;
      holders.set(tx.service, (holders.get(tx.service) ?? 0) + hold);
      for (const a of nestedAcquires) {
        const w = Math.min(a.endUs, tx.endUs) - Math.max(a.startUs, tx.startUs);
        if (w > 0) waiters.set(a.service, (waiters.get(a.service) ?? 0) + w);
      }
      txEvidence.push({ id: spanEvidence(tx), nested });
      for (const a of nestedAcquires.slice(0, 1))
        txEvidence.push({ id: spanEvidence(a), nested: nested - 1 });
    }
  }
  const nestedWaitShare = holdTotal === 0 ? null : round3(nestedTotal / holdTotal);
  const byValue = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

  const criteria = [
    {
      name: 'pool saturated (median utilization)',
      met: medianUtilization !== null && medianUtilization >= satT,
      value: medianUtilization,
      threshold: satT,
    },
    {
      name: 'in-use connections mostly idle-held (median fraction)',
      met: medianIdle !== null && medianIdle >= idleT,
      value: medianIdle,
      threshold: idleT,
    },
    {
      name: 'transactions wait for further connections (share of hold time)',
      met: nestedWaitShare !== null && nestedWaitShare >= nestedT,
      value: nestedWaitShare,
      threshold: nestedT,
    },
  ];
  return {
    window,
    pool: {
      samples: rows.length,
      medianInUse: med(rows.map((r) => r.inUse.value)),
      medianCapacity: med(rows.map((r) => r.cap.value)),
      medianUtilization,
      medianDbActive: med(rows.map((r) => r.act.value)),
      medianIdleHeldFraction: medianIdle,
      evidenceIds: [...new Set(poolEvidence)],
    },
    transactions: {
      count: holds.length,
      holdP50Us: holds.length === 0 ? null : Math.round(quantile(holds, 0.5)),
      holdP95Us: holds.length === 0 ? null : Math.round(quantile(holds, 0.95)),
      nestedWaitShare,
      holders: byValue(holders).map(([service, holdUs]) => ({ service, holdUs })),
      waiters: byValue(waiters).map(([service, waitUs]) => ({ service, waitUs })),
      evidenceIds: txEvidence
        .sort((a, b) => b.nested - a.nested || (a.id < b.id ? -1 : 1))
        .slice(0, 6)
        .map((e) => e.id),
    },
    detected: criteria.every((c) => c.met),
    criteria,
  };
}
