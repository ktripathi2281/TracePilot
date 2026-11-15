import { describe, expect, it } from 'vitest';
import { attributeLatency } from './attribution.ts';
import { buildDependencyGraph, downstreamOf, upstreamOf } from './graph.ts';
import { MS, TraceBuilder, checkoutTrace } from './testkit.ts';
import { buildTraces, criticalPath, unionLength } from './traces.ts';

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe('critical path', () => {
  it('tiles the root exactly and descends into the child that finished last', () => {
    const b = new TraceBuilder();
    const root = b.span('a', 'op', 0, 100 * MS);
    b.span('b', 'fast', 10 * MS, 30 * MS, { parent: root });
    b.span('c', 'slow', 10 * MS, 80 * MS, { parent: root }); // parallel sibling, ends later
    const segs = criticalPath(b.tree());
    expect(sum(segs.map((s) => s.endUs - s.startUs))).toBe(100 * MS);
    expect(segs.map((s) => [s.span.service, s.startUs / MS, s.endUs / MS])).toEqual([
      ['a', 0, 10],
      ['c', 10, 80],
      ['a', 80, 100],
    ]);
  });

  it('clips abandoned work that outlives its parent', () => {
    const b = new TraceBuilder();
    const root = b.span('a', 'op', 0, 50 * MS, { status: 'timeout' });
    b.span('b', 'op', 5 * MS, 400 * MS, {
      parent: root,
      status: 'error',
      attrs: { cancelled: true },
    });
    const segs = criticalPath(b.tree());
    expect(sum(segs.map((s) => s.endUs - s.startUs))).toBe(50 * MS);
    expect(segs.at(-1)).toMatchObject({ endUs: 50 * MS });
  });

  it('splits db.query into DB-queue and execution time', () => {
    const b = new TraceBuilder();
    const root = b.span('a', 'op', 0, 30 * MS);
    b.span('a', 'db.query', 5 * MS, 25 * MS, {
      parent: root,
      attrs: { 'db.queue_wait_us': 8 * MS },
    });
    const cats = criticalPath(b.tree()).map((s) => [s.category, (s.endUs - s.startUs) / MS]);
    expect(cats).toEqual([
      ['compute', 5],
      ['db_queue', 8],
      ['query_exec', 12],
      ['compute', 5],
    ]);
  });

  it('marks time inside a transaction as held-connection and records enclosing services', () => {
    const segs = criticalPath(checkoutTrace(0, { acquireWaitUs: 500 * MS }).tree());
    const wait = segs.find((s) => s.category === 'pool_acquire' && s.span.service === 'inventory');
    expect(wait).toMatchObject({ heldConnection: true });
    expect(wait?.enclosingServices).toEqual(['api-gateway', 'checkout', 'inventory']);
    expect(segs[0]?.heldConnection).toBe(false);
  });

  it('drops traces with a missing parent or several roots', () => {
    const b = new TraceBuilder();
    b.span('a', 'op', 0, 10, { parent: '00000000deadbeef' });
    const c = new TraceBuilder();
    c.span('a', 'op', 0, 10);
    c.span('a', 'op', 0, 10);
    expect(buildTraces([...b.spans, ...c.spans])).toEqual([]);
  });

  it('measures the union of overlapping intervals', () => {
    expect(
      unionLength(
        [
          [0, 10],
          [5, 15],
          [20, 25],
        ],
        0,
        100,
      ),
    ).toBe(20);
    expect(unionLength([[0, 10]], 5, 8)).toBe(3);
    expect(unionLength([], 0, 10)).toBe(0);
  });
});

describe('latency attribution', () => {
  const healthy = Array.from({ length: 20 }, (_, i) => checkoutTrace(i * 1_000 * MS).tree());
  const jammed = Array.from({ length: 20 }, (_, i) =>
    checkoutTrace(i * 1_000 * MS, { acquireWaitUs: 2_000 * MS }).tree(),
  );
  const failed = Array.from({ length: 10 }, (_, i) =>
    checkoutTrace(i * 1_000 * MS, { acquireWaitUs: 5_000 * MS, status: 'timeout' }).tree(),
  );

  it('attributes healthy requests mostly to query execution', () => {
    const [g] = attributeLatency(healthy).groups;
    expect(g).toMatchObject({ outcome: 'success', traces: 20, dominant: 'query_exec' });
    expect(g?.shares.pool_acquire).toBe(0);
  });

  it('separates successes from failures and finds pool-acquire wait dominating both when jammed', () => {
    const r = attributeLatency([...jammed, ...failed]);
    expect(r.groups.map((g) => [g.outcome, g.traces, g.dominant])).toEqual([
      ['success', 20, 'pool_acquire'],
      ['failure', 10, 'pool_acquire'],
    ]);
    const success = r.groups[0];
    expect(sum(Object.values(success?.shares ?? {}))).toBeCloseTo(1, 2);
    // The wait happened while checkout held a connection: the hold-and-wait signature.
    expect(success?.heldConnection.byCategory.pool_acquire).toBe(success?.totals.pool_acquire);
    // checkout's time is mostly spent waiting on inventory (downstream), not on itself.
    const co = success?.byService['checkout'];
    expect(co?.downstream).toBeGreaterThan(10 * ((co?.compute ?? 0) + (co?.query_exec ?? 0)));
    expect(success?.evidenceIds.length).toBeGreaterThan(0);
  });

  it('filters by minimum duration', () => {
    expect(attributeLatency([...healthy, ...jammed], { minDurationUs: 1_000 * MS }).traces).toBe(
      20,
    );
  });
});

describe('dependency graph', () => {
  it('derives call, database and external edges and the entry service from spans', () => {
    const b = checkoutTrace(0);
    const pay = b.span('payment', 'charge', 100, 900, { parent: b.spans[1]?.spanId ?? null });
    b.span('payment', 'provider.authorize', 200, 800, {
      parent: pay,
      attrs: { 'peer.service': 'psp' },
    });
    const g = buildDependencyGraph(b.spans);
    expect(g.entryServices).toEqual(['api-gateway']);
    expect(g.nodes.map((n) => [n.service, n.kind])).toEqual([
      ['api-gateway', 'service'],
      ['checkout', 'service'],
      ['db', 'database'],
      ['inventory', 'service'],
      ['payment', 'service'],
      ['psp', 'external'],
    ]);
    expect(g.edges.map((e) => [e.from, e.to, e.kind, e.callerOperations.join(',')])).toEqual([
      ['api-gateway', 'checkout', 'call', 'checkout'],
      ['checkout', 'db', 'database', 'place-order'],
      ['checkout', 'inventory', 'call', 'place-order'],
      ['checkout', 'payment', 'call', 'place-order'],
      ['inventory', 'db', 'database', 'reserve'],
      ['payment', 'psp', 'external', 'charge'],
    ]);
    expect(downstreamOf(g, 'checkout')).toEqual(new Set(['db', 'inventory', 'payment', 'psp']));
    expect(upstreamOf(g, 'db')).toEqual(new Set(['checkout', 'inventory', 'api-gateway']));
  });

  it('counts failed acquires as database attempts and errors', () => {
    const g = buildDependencyGraph(
      checkoutTrace(0, { acquireWaitUs: 5_000 * MS, status: 'timeout' }).spans,
    );
    const inv = g.edges.find((e) => e.from === 'inventory' && e.to === 'db');
    expect(inv).toMatchObject({ callCount: 1, errorCount: 1 });
  });
});
