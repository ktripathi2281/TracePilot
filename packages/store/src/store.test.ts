import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangeEvent, LogRecord, MetricPoint, Span } from '@tracepilot/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { TelemetryStore, hashBundle, incidentIdFor, type TelemetryBundle } from './store.ts';

const T = (n: number) => n.toString(16).padStart(32, '0');
const S = (n: number) => n.toString(16).padStart(16, '0');

function bundle(offset = 0): TelemetryBundle {
  const spans: Span[] = [
    {
      traceId: T(1),
      spanId: S(1),
      parentSpanId: null,
      service: 'gw',
      name: 'checkout',
      startUs: 1_000,
      endUs: 9_000,
      status: 'ok',
      attributes: { 'http.status_code': 200 },
    },
    {
      traceId: T(1),
      spanId: S(2),
      parentSpanId: S(1),
      service: 'checkout',
      name: 'db.pool.acquire',
      startUs: 2_000,
      endUs: 2_500,
      status: 'ok',
      attributes: { 'db.pool.in_use': 3, 'db.pool.capacity': 10 },
    },
    {
      traceId: T(2),
      spanId: S(3),
      parentSpanId: null,
      service: 'gw',
      name: 'stock',
      startUs: 6_000_000,
      endUs: 11_000_000,
      status: 'timeout',
      attributes: {},
    },
  ];
  const logs: LogRecord[] = [
    {
      id: 'lg_0',
      ts: 1_500,
      service: 'checkout',
      level: 'info',
      message: 'checkout 200',
      fields: {},
      traceId: T(1),
    },
    {
      id: 'lg_1',
      ts: 7_000_000,
      service: 'inventory',
      level: 'error',
      message: 'Timeout acquiring connection after 5000ms',
      fields: { poolInUse: 10 },
    },
    {
      id: 'lg_2',
      ts: 8_000_000,
      service: 'inventory',
      level: 'warn',
      message: 'slow DNS lookup',
      fields: {},
    },
  ];
  const metrics: MetricPoint[] = [5, 10, 15].flatMap((s) => [
    {
      ts: s * 1_000_000,
      service: 'db',
      name: 'pool_in_use' as const,
      value: s + offset,
      labels: {},
    },
    {
      ts: s * 1_000_000,
      service: 'gw',
      name: 'error_rate' as const,
      value: s === 15 ? 0.5 : 0,
      labels: {},
    },
  ]);
  const changeEvents: ChangeEvent[] = [
    {
      id: 'ev_1',
      ts: 4_000_000,
      kind: 'deploy',
      service: 'checkout',
      description: 'v2',
      diff: { workers: { from: 20, to: 60 } },
    },
  ];
  return { spans, logs, metrics, changeEvents, podEvents: [] };
}

let store: TelemetryStore;
afterEach(() => {
  store.close();
});

describe('ingest', () => {
  it('stores telemetry under a neutral, hash-derived incident ID and derives incident facts', () => {
    store = new TelemetryStore(':memory:');
    const b = bundle();
    const { incident, created } = store.ingest(b);
    expect(created).toBe(true);
    expect(incident.id).toBe(incidentIdFor(hashBundle(b)));
    expect(incident.id).toMatch(/^in_[0-9a-z]+$/);
    expect(incident).toMatchObject({
      source: 'synthetic',
      startUs: 0,
      endUs: 15_000_000,
      metricIntervalUs: 5_000_000,
      services: ['checkout', 'db', 'gw'],
      counts: { spans: 3, logs: 3, metrics: 6, changeEvents: 1, podEvents: 0 },
    });
  });

  it('is idempotent for identical telemetry and separates different incidents', () => {
    store = new TelemetryStore(':memory:');
    const first = store.ingest(bundle()).incident;
    expect(store.ingest(bundle())).toEqual({ incident: first, created: false });
    const second = store.ingest(bundle(1)).incident;
    expect(second.id).not.toBe(first.id);
    expect(store.listIncidents()).toHaveLength(2);
  });

  it('rejects invalid telemetry and writes nothing', () => {
    store = new TelemetryStore(':memory:');
    const bad = bundle();
    const broken = { ...bad, spans: [...bad.spans, { ...bad.spans[0], endUs: 0 } as Span] };
    expect(() => store.ingest(broken)).toThrow(/invalid span #3/);
    const dupLogs = { ...bad, logs: [...bad.logs, bad.logs[0] as LogRecord] };
    expect(() => store.ingest(dupLogs)).toThrow();
    expect(store.listIncidents()).toEqual([]);
  });

  it('round-trips telemetry exactly (same canonical hash) and persists across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracepilot-store-'));
    try {
      const path = join(dir, 'telemetry.db');
      const writer = new TelemetryStore(path);
      const { incident } = writer.ingest(bundle());
      writer.close();
      store = new TelemetryStore(path);
      const back = store.exportTelemetry(incident.id);
      expect(back).toEqual(bundle());
      expect(hashBundle(back)).toBe(incident.telemetryHash);
    } finally {
      store.close();
      store = new TelemetryStore(':memory:');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('queries', () => {
  const setup = () => {
    store = new TelemetryStore(':memory:');
    return store.ingest(bundle()).incident.id;
  };

  it('returns one metric series in time order within [from, to)', () => {
    const id = setup();
    expect(
      store.getMetricSeries(id, { service: 'db', name: 'pool_in_use' }).map((p) => p.value),
    ).toEqual([5, 10, 15]);
    expect(
      store
        .getMetricSeries(id, {
          service: 'db',
          name: 'pool_in_use',
          fromUs: 10_000_000,
          toUs: 15_000_000,
        })
        .map((p) => p.ts),
    ).toEqual([10_000_000]);
    expect(store.listMetricSeries(id)).toEqual([
      { service: 'db', name: 'pool_in_use', points: 3 },
      { service: 'gw', name: 'error_rate', points: 3 },
    ]);
    expect(store.getMetrics(id, { service: 'gw' })).toHaveLength(3);
  });

  it('filters spans by service, name, status, roots and time', () => {
    const id = setup();
    expect(store.getSpans(id, { service: 'gw' }).map((s) => s.spanId)).toEqual([S(1), S(3)]);
    expect(store.getSpans(id, { name: 'db.pool.acquire' })).toHaveLength(1);
    expect(store.getSpans(id, { status: 'timeout' }).map((s) => s.spanId)).toEqual([S(3)]);
    expect(store.getSpans(id, { rootsOnly: true })).toHaveLength(2);
    expect(store.getSpans(id, { fromUs: 5_000_000 }).map((s) => s.spanId)).toEqual([S(3)]);
    expect(store.getSpans(id, { timeField: 'end', toUs: 10_000 })).toHaveLength(2);
    expect(store.getSpans(id, { limit: 1 })).toHaveLength(1);
  });

  it('returns traces whole and groups traces by root start', () => {
    const id = setup();
    expect(store.getTrace(id, T(1)).map((s) => s.spanId)).toEqual([S(1), S(2)]);
    expect(store.getTrace(id, T(9))).toEqual([]);
    expect(store.getTracesByRootStart(id, { toUs: 5_000_000 }).map((t) => t.length)).toEqual([2]);
    expect(store.getTracesByRootStart(id, { rootName: 'stock' }).map((t) => t[0]?.spanId)).toEqual([
      S(3),
    ]);
  });

  it('searches logs by level, text (case-insensitive), service, trace and time', () => {
    const id = setup();
    expect(store.searchLogs(id, { levels: ['error', 'warn'] }).map((l) => l.id)).toEqual([
      'lg_1',
      'lg_2',
    ]);
    expect(store.searchLogs(id, { contains: 'timeout ACQUIRING' }).map((l) => l.id)).toEqual([
      'lg_1',
    ]);
    expect(store.searchLogs(id, { traceId: T(1) }).map((l) => l.id)).toEqual(['lg_0']);
    expect(store.searchLogs(id, { service: 'inventory', limit: 1 }).map((l) => l.id)).toEqual([
      'lg_1',
    ]);
    expect(store.searchLogs(id, { fromUs: 7_500_000 }).map((l) => l.id)).toEqual(['lg_2']);
  });

  it('lists change events in a window', () => {
    const id = setup();
    expect(store.listChangeEvents(id).map((c) => c.id)).toEqual(['ev_1']);
    expect(store.listChangeEvents(id, { fromUs: 5_000_000 })).toEqual([]);
    expect(store.listPodEvents(id)).toEqual([]);
  });

  it('rejects unknown incidents', () => {
    setup();
    expect(() => store.getSpans('in_nope')).toThrow(/unknown incident/);
  });
});

describe('evidence lookup', () => {
  it('resolves every evidence kind and nothing else', () => {
    store = new TelemetryStore(':memory:');
    const id = store.ingest(bundle()).incident.id;
    expect(store.getEvidence(id, `sp_${S(2)}`)).toMatchObject({
      kind: 'span',
      item: { name: 'db.pool.acquire' },
    });
    expect(store.getEvidence(id, 'lg_1')).toMatchObject({ kind: 'log', item: { level: 'error' } });
    expect(store.getEvidence(id, 'mt_db_pool_in_use_10000000')).toMatchObject({
      kind: 'metric',
      item: { value: 10 },
    });
    expect(store.getEvidence(id, 'ev_1')).toMatchObject({
      kind: 'change',
      item: { service: 'checkout' },
    });
    for (const missing of [
      `sp_${S(9)}`,
      'lg_9',
      'mt_db_pool_in_use_10000001',
      'mt_db_pool_in_use_010000000',
      'ev_9',
      'pe_1',
      'nonsense',
    ]) {
      expect(store.getEvidence(id, missing), missing).toBeUndefined();
    }
  });

  it('scopes evidence IDs by incident', () => {
    store = new TelemetryStore(':memory:');
    const a = store.ingest(bundle()).incident.id;
    const b = store.ingest(bundle(1)).incident.id;
    expect(store.getEvidence(a, 'mt_db_pool_in_use_5000000')?.item).toMatchObject({ value: 5 });
    expect(store.getEvidence(b, 'mt_db_pool_in_use_5000000')?.item).toMatchObject({ value: 6 });
  });
});

describe('information boundary', () => {
  it('has no table or column for configuration, recordings, scenarios or ground truth', () => {
    store = new TelemetryStore(':memory:');
    const names = store
      .describeSchema()
      .flatMap((t) => [t.table, ...t.columns])
      .join(' ')
      .toLowerCase();
    for (const banned of [
      'config',
      'scenario',
      'recording',
      'workload',
      'seed',
      'truth',
      'model',
      'disturbance',
      'label_truth',
    ]) {
      expect(names.includes(banned), banned).toBe(false);
    }
    expect(store.describeSchema().map((t) => t.table)).toEqual([
      'change_events',
      'incidents',
      'logs',
      'metrics',
      'pod_events',
      'spans',
    ]);
  });
});
