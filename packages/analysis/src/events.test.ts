import type { ChangeEvent, DependencyGraph, LogRecord } from '@tracepilot/schema';
import { describe, expect, it } from 'vitest';
import type { Anomaly } from './anomaly.ts';
import { correlateChanges } from './changes.ts';
import { compareSeries, dbQueryProfile } from './compare.ts';
import { detectLogBursts, logTemplate } from './logs.ts';
import { medianItems, quantile, robustStats } from './stats.ts';
import { MS, S, TICK, TraceBuilder, at, noise, points } from './testkit.ts';
import { buildTimeline } from './timeline.ts';
import { toSeries } from './series.ts';
import { inferIncidentWindows } from './windows.ts';

const node = (service: string) => ({
  service,
  kind: 'service' as const,
  spanCount: 1,
  errorCount: 0,
});
const edge = (from: string, to: string) => ({
  from,
  to,
  kind: 'call' as const,
  callerOperations: ['op'],
  callCount: 1,
  errorCount: 0,
  latencyP50Us: 1,
  latencyP95Us: 1,
  evidenceIds: ['sp_0000000000000001'],
});
// gateway → checkout → {inventory, payment}
const graph: DependencyGraph = {
  nodes: ['gateway', 'checkout', 'inventory', 'payment'].map(node),
  edges: [edge('gateway', 'checkout'), edge('checkout', 'inventory'), edge('checkout', 'payment')],
  entryServices: ['gateway'],
};
const anomaly = (
  service: string,
  onsetUs: number,
  status: Anomaly['status'] = 'ongoing',
): Anomaly =>
  ({
    service,
    metric: 'latency_p99',
    direction: 'up',
    onsetUs,
    onsetResolutionUs: TICK,
    endUs: status === 'recovered' ? onsetUs + 20 * S : null,
    status,
    evidenceIds: [`mt_${service}_latency_p99_${String(onsetUs)}`],
  }) as Anomaly;
const change = (id: string, service: string, ts: number): ChangeEvent => ({
  id,
  ts,
  kind: 'config',
  service,
  description: `${service} change`,
  diff: {},
});

describe('change correlation', () => {
  it('correlates a change with an anomaly in the changed service itself', () => {
    const [c] = correlateChanges(
      [change('ev_1', 'checkout', 600 * S)],
      [anomaly('checkout', 605 * S), anomaly('gateway', 605 * S)],
      graph,
    );
    expect(c).toMatchObject({ verdict: 'correlated', sustained: true });
    expect(c?.following.map((f) => [f.service, f.relation])).toEqual([
      ['checkout', 'self'],
      ['gateway', 'upstream'],
    ]);
  });

  it('does not blame a change when upstream anomalies are explained by an unrelated sibling', () => {
    // inventory changed; then payment (a sibling, unrelated to inventory) and its callers degrade.
    const [c] = correlateChanges(
      [change('ev_1', 'inventory', 390 * S)],
      [
        anomaly('payment', 425 * S, 'recovered'),
        anomaly('checkout', 425 * S, 'recovered'),
        anomaly('gateway', 425 * S, 'recovered'),
      ],
      graph,
    );
    expect(c?.verdict).toBe('none');
    expect(c?.following.find((f) => f.service === 'checkout')?.alternativeOrigin?.service).toBe(
      'payment',
    );
    expect(c?.following.find((f) => f.service === 'payment')?.relation).toBe('unrelated');
    expect(c?.reason).toMatch(/explained by an earlier-or-equal anomaly in payment/);
  });

  it('prefers a nearer intervening change', () => {
    const [first] = correlateChanges(
      [change('ev_1', 'checkout', 500 * S), change('ev_2', 'checkout', 590 * S)],
      [anomaly('checkout', 600 * S)],
      graph,
    );
    expect(first?.following[0]?.interveningChange).toBe('ev_2');
    expect(first?.verdict).toBe('none');
  });

  it('ignores anomalies outside the lag and before the change (negative case)', () => {
    const [c] = correlateChanges(
      [change('ev_1', 'checkout', 600 * S)],
      [anomaly('checkout', 590 * S), anomaly('checkout', 900 * S)],
      graph,
    );
    expect(c?.following).toEqual([]);
    expect(c?.verdict).toBe('none');
  });

  it('is weak when only related services react without another explanation', () => {
    const [c] = correlateChanges(
      [change('ev_1', 'inventory', 600 * S)],
      [anomaly('gateway', 610 * S)],
      graph,
    );
    expect(c?.verdict).toBe('weak');
  });
});

describe('log bursts', () => {
  let n = 0;
  const log = (
    ts: number,
    message: string,
    level: LogRecord['level'] = 'error',
    service = 'svc',
  ): LogRecord => ({
    id: `lg_${(n++).toString(36)}`,
    ts,
    service,
    level,
    message,
    fields: {},
  });
  const baseline = { fromUs: 0, toUs: 300 * S };

  it('templates numbers', () => {
    expect(logTemplate('timeout acquiring connection after 5000ms')).toBe(
      'timeout acquiring connection after Nms',
    );
    expect(logTemplate('took 12.5 ms')).toBe('took N ms');
  });

  it('finds a sparse burst of sampled errors, merging small gaps, and leaves background noise alone', () => {
    const logs: LogRecord[] = [];
    // Background: a warn every 30 s for the whole run.
    for (let t = 0; t < 900 * S; t += 30 * S) logs.push(log(t, 'slow DNS lookup 12ms', 'warn'));
    // Incident: an error in most 5 s buckets from 600 s on, with gaps.
    for (let k = 0; k < 40; k++)
      if (k % 4 !== 3)
        logs.push(log(600 * S + k * TICK + 100, `timeout acquiring connection after 5000ms`));
    const bursts = detectLogBursts(logs, { baseline, bucketUs: TICK });
    expect(bursts.map((b) => [b.template, b.startUs, b.endUs])).toEqual([
      ['timeout acquiring connection after Nms', 600 * S + 100, 795 * S],
    ]);
    expect(bursts[0]?.evidenceIds.length).toBe(5);
  });

  it('reports a burst that ended', () => {
    const logs = [0, 1, 2, 3].map((k) =>
      log(420 * S + k * TICK + 1, 'provider slow 300ms', 'warn'),
    );
    logs.push(log(900 * S, 'unrelated', 'info'));
    const [b] = detectLogBursts(logs, { baseline, bucketUs: TICK });
    expect(b).toMatchObject({ startUs: 420 * S + 1, endUs: 440 * S, count: 4 });
  });

  it('finds nothing in steady background noise (negative case)', () => {
    const logs: LogRecord[] = [];
    for (let t = 0; t < 900 * S; t += 7 * S) logs.push(log(t, 'gc pause 3ms', 'warn'));
    expect(detectLogBursts(logs, { baseline, bucketUs: TICK })).toEqual([]);
  });
});

describe('window comparison', () => {
  const dbSpans = (count: number, from: number, execMs: (i: number) => number, statement = 'q') =>
    Array.from({ length: count }, (_, i) => {
      const b = new TraceBuilder();
      const t = from + i * 100 * MS;
      b.span('svc', 'db.query', t, t + execMs(i) * MS + 3 * MS, {
        attrs: { 'db.statement': statement, 'db.queue_wait_us': 3 * MS },
      });
      return b.spans[0] as NonNullable<(typeof b.spans)[0]>;
    });
  const jitter = noise(400, 7, 0.2);
  const base = { fromUs: 0, toUs: 100 * S };
  const win = { fromUs: 100 * S, toUs: 200 * S };

  it('calls execution time flat when queue wait is excluded and the interval is tight', () => {
    const spans = [
      ...dbSpans(300, 0, (i) => 50 * (1 + (jitter[i] ?? 0))),
      ...dbSpans(200, 100 * S, (i) => 50 * (1 + (jitter[i + 200] ?? 0))),
    ];
    const p = dbQueryProfile(spans, base, win);
    expect(p.execFlat).toBe(true);
    expect(p.exec[0]).toMatchObject({ key: 'svc/q', shift: 'flat' });
    expect(p.exec[0]?.ratioInterval?.[0]).toBeGreaterThan(0.9);
  });

  it('detects slower execution', () => {
    const spans = [
      ...dbSpans(300, 0, () => 50),
      ...dbSpans(200, 100 * S, (i) => 100 * (1 + (jitter[i] ?? 0) / 4)),
    ];
    const p = dbQueryProfile(spans, base, win);
    expect(p.exec[0]?.shift).toBe('up');
    expect(p.execFlat).toBe(false);
  });

  it('is inconclusive on few noisy samples and refuses on too few', () => {
    const wide = noise(40, 11, 0.6);
    const spans = [
      ...dbSpans(300, 0, (i) => 50 * (1 + (wide[i % 40] ?? 0))),
      ...dbSpans(12, 100 * S, (i) => 62 * (1 + (wide[i] ?? 0))),
    ];
    expect(dbQueryProfile(spans, base, win).exec[0]?.shift).toBe('inconclusive');
    const tiny = [...dbSpans(300, 0, () => 50), ...dbSpans(5, 100 * S, () => 50)];
    expect(dbQueryProfile(tiny, base, win).exec[0]?.shift).toBe('insufficient-data');
  });

  it('compares metric series, including all-zero baselines', () => {
    const [s] = toSeries(
      points('db', 'queue_depth', [
        ...Array.from({ length: 20 }, () => 0),
        ...Array.from({ length: 20 }, () => 0),
      ]),
    );
    if (s === undefined) throw new Error('no series');
    expect(
      compareSeries(s, { fromUs: 0, toUs: at(20) }, { fromUs: at(20), toUs: at(40) }).shift,
    ).toBe('flat');
  });
});

describe('timeline', () => {
  it('orders changes, anomaly onsets, bursts and recoveries on one axis', () => {
    const t = buildTimeline({
      changes: [change('ev_2', 'checkout', 600 * S)],
      anomalies: [
        {
          ...anomaly('db', 605 * S),
          unit: 'count',
          metric: 'pool_wait_queue',
          baseline: { median: 0 },
          value: { median: 250 },
        } as unknown as Anomaly,
      ],
      logBursts: [
        {
          service: 'svc',
          level: 'error',
          template: 't',
          startUs: 606 * S,
          endUs: null,
          count: 3,
          activeBuckets: 3,
          peakPerBucket: 1,
          baselinePerBucket: 0,
          threshold: 1,
          evidenceIds: ['lg_1'],
        },
      ],
      spanOnsets: [
        {
          label: 'db pool observed full',
          service: 'db',
          ts: 600 * S + 50 * MS,
          resolutionUs: 10 * MS,
          basis: 'span',
          evidenceIds: ['sp_0000000000000001'],
        },
      ],
    });
    expect(t.map((e) => [e.kind, e.service])).toEqual([
      ['change', 'checkout'],
      ['span_onset', 'db'],
      ['anomaly_onset', 'db'],
      ['log_burst', 'svc'],
    ]);
    expect(t[2]?.summary).toBe('pool_wait_queue up: 0 → 250');
    expect(t.every((e) => e.evidenceIds.length > 0)).toBe(true);
  });
});

describe('incident windows', () => {
  const N = 180;
  const build = (onsetIdx: number | null) => {
    const err = Array.from({ length: N }, (_, i) => (onsetIdx !== null && i >= onsetIdx ? 0.6 : 0));
    const lat = noise(N, 5, 10_000).map((x, i) =>
      onsetIdx !== null && i >= onsetIdx ? 5_000_000 : 120_000 + x,
    );
    return toSeries([...points('gw', 'error_rate', err), ...points('gw', 'latency_p99', lat)]);
  };

  it('finds the user-facing symptom and a clean pre-symptom baseline', () => {
    const w = inferIncidentWindows(build(120), {
      range: { fromUs: 0, toUs: at(N - 1) },
      entryServices: ['gw'],
    });
    expect(w?.symptom).toMatchObject({
      service: 'gw',
      metric: 'error_rate',
      onsetUs: at(120),
      status: 'ongoing',
    });
    expect(w?.baseline).toEqual({ fromUs: 60 * S, toUs: at(120) - TICK - 60 * S });
    expect(w?.incident.fromUs).toBe(at(120) - TICK);
  });

  it('returns null when there is no symptom (negative case)', () => {
    expect(
      inferIncidentWindows(build(null), {
        range: { fromUs: 0, toUs: at(N - 1) },
        entryServices: ['gw'],
      }),
    ).toBeNull();
  });
});

describe('robust statistics', () => {
  it('computes quantiles, MAD and the items that define a median', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(robustStats([1, 1, 2, 2, 4, 6, 9])).toMatchObject({ median: 2, mad: 1 });
    expect(medianItems([{ v: 3 }, { v: 1 }, { v: 2 }], (x) => x.v)).toEqual([{ v: 2 }]);
    expect(medianItems([{ v: 3 }, { v: 1 }, { v: 2 }, { v: 4 }], (x) => x.v)).toEqual([
      { v: 2 },
      { v: 3 },
    ]);
    expect(() => quantile([], 0.5)).toThrow();
  });
});
