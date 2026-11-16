// Unit tests of the comparison logic on hand-built summaries. Scenario-level behaviour (identity
// replay, the recommended patches, the sweep) is tested in eval/src/gate4.test.ts.

import { describe, expect, it } from 'vitest';
import { TRANSIENT_BUCKETS, headlineDeltas, parseRange, sideEffects, verdictOf } from './replay.ts';
import { degraded, requestStats, type ResourceState, type RunSummary } from './summary.ts';

const stats = (failed: number, p99Us: number, requests = 1000) => ({
  requests,
  failed,
  timedOut: 0,
  errorRate: failed / requests,
  p50Us: p99Us / 4,
  p95Us: p99Us / 2,
  p99Us,
  goodputPerS: (requests - failed) / 300,
});
const resource = (name: string, status: ResourceState['status'], queueMean = 0): ResourceState => ({
  resource: name,
  kind: 'workers',
  status,
  capacity: null,
  utilizationMean: null,
  queueMean,
  queueMax: queueMean,
  saturatedShare: 0,
});
const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  telemetryHash: 'h',
  incident: stats(0, 100_000),
  byType: {},
  degradedUs: 0,
  firstDegradedUs: null,
  pool: { acquireTimeouts: 0, totalAcquireWaitUs: 0, totalHoldUs: 0 },
  db: { totalQueueWaitUs: 0, totalExecUs: 0 },
  failures: [],
  saturation: [],
  series: [],
  ...over,
});
const T = { bucketUs: 5_000_000, maxErrorRate: 0.01, maxP99Us: 1_000_000 };

describe('verdict rubric', () => {
  const original = summary({ incident: stats(600, 16_000_000), degradedUs: 300_000_000 });
  const verdict = (replay: RunSummary) => verdictOf(headlineDeltas(original, replay), replay, T);

  it('resolves: no lasting degradation and errors under the threshold', () => {
    expect(verdict(summary())).toBe('resolves');
    // A transient at the moment of the change is allowed...
    expect(verdict(summary({ degradedUs: TRANSIENT_BUCKETS * T.bucketUs }))).toBe('resolves');
    // ...a longer stretch is not.
    expect(verdict(summary({ degradedUs: (TRANSIENT_BUCKETS + 1) * T.bucketUs }))).toBe('improves');
  });

  it('improves, worsens, mixed and no_change', () => {
    expect(verdict(summary({ incident: stats(200, 900_000), degradedUs: 60_000_000 }))).toBe(
      'improves',
    );
    expect(verdict(summary({ incident: stats(700, 16_000_000), degradedUs: 300_000_000 }))).toBe(
      'worsens',
    );
    // Same failures but a worse p99: worse.
    expect(verdict(summary({ incident: stats(600, 20_000_000), degradedUs: 300_000_000 }))).toBe(
      'worsens',
    );
    // Fewer failures but a worse p99: mixed.
    expect(verdict(summary({ incident: stats(300, 20_000_000), degradedUs: 300_000_000 }))).toBe(
      'mixed',
    );
    expect(verdict(original)).toBe('no_change');
  });

  it('counts goodput as higher-is-better and treats tiny changes as the same', () => {
    const d = headlineDeltas(
      original,
      summary({ incident: stats(600, 16_000_100), degradedUs: 300_000_000 }),
    );
    expect(d.find((x) => x.key === 'p99Us')?.direction).toBe('same');
    const g = headlineDeltas(original, summary()).find((x) => x.key === 'goodputPerS');
    expect(g?.direction).toBe('better');
    expect(g?.change).toBeGreaterThan(0);
  });
});

describe('side effects', () => {
  it('names new bottlenecks, relieved ones, new queues and services with more errors', () => {
    const original = summary({
      saturation: [
        resource('db.pool', 'saturated', 250),
        resource('db.executor', 'unknown-capacity'),
        resource('payment.workers', 'ok'),
      ],
      failures: [
        {
          service: 'checkout',
          responses: 10,
          errors: 5,
          rejected: 0,
          sampledTimeoutSpans: 0,
          firstFailingUs: null,
        },
      ],
    });
    const replay = summary({
      saturation: [
        resource('db.pool', 'ok', 2),
        resource('db.executor', 'saturated', 8),
        resource('payment.workers', 'ok', 3),
      ],
      failures: [
        {
          service: 'checkout',
          responses: 10,
          errors: 7,
          rejected: 0,
          sampledTimeoutSpans: 0,
          firstFailingUs: null,
        },
      ],
    });
    expect(sideEffects(original, replay).map((s) => `${s.kind} ${s.subject}`)).toEqual([
      'relieved db.pool',
      'new_bottleneck db.executor',
      'queue_formed payment.workers',
      'more_errors checkout',
    ]);
    expect(sideEffects(original, original)).toEqual([]);
  });
});

describe('degraded time', () => {
  const o = (endUs: number, latencyUs: number, ok = true) => ({
    requestId: endUs,
    type: 'checkout',
    arrivalUs: endUs - latencyUs,
    endUs,
    status: ok ? ('ok' as const) : ('error' as const),
    httpStatus: ok ? 200 : 500,
  });
  const w = { fromUs: 0, toUs: 15_000_000 };

  it('counts buckets with too many errors, too slow a p99, or nothing finished', () => {
    const outcomes = [
      o(1_000_000, 10_000),
      o(2_000_000, 10_000),
      o(6_000_000, 10_000, false), // bucket 1: 100 % errors
      // bucket 2 (10–15 s): nothing finished
    ];
    expect(degraded(outcomes, w, T)).toEqual({
      degradedUs: 10_000_000,
      firstDegradedUs: 5_000_000,
    });
    expect(degraded([o(1_000_000, 2_000_000)], { fromUs: 0, toUs: 5_000_000 }, T).degradedUs).toBe(
      5_000_000,
    );
    expect(requestStats(outcomes, w)).toMatchObject({ requests: 3, failed: 1, errorRate: 1 / 3 });
  });
});

describe('ranges', () => {
  it('parses from:to:step inclusively and rejects nonsense', () => {
    expect(parseRange('20:120:10')).toEqual([20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    expect(parseRange('5:5:1')).toEqual([5]);
    expect(() => parseRange('20-120')).toThrow(/<from>:<to>:<step>/);
    expect(() => parseRange('20:10:5')).toThrow(/below its start/);
    expect(() => parseRange('1:10:0')).toThrow(/positive/);
    expect(() => parseRange('1:1000:1')).toThrow(/at most 50/);
  });
});
