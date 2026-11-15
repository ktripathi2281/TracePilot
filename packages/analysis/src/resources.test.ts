import { describe, expect, it } from 'vitest';
import { analyzeHoldAndWait } from './holdwait.ts';
import { analyzeSaturation } from './saturation.ts';
import { MS, TICK, at, checkoutTrace, noise, points } from './testkit.ts';

const N = 60;
const BASE = { fromUs: at(0), toUs: at(30) };
const WIN = { fromUs: at(30), toUs: at(N) };
const constant = (v: number, n = N): number[] => Array.from({ length: n }, () => v);
const split = (a: number, b: number): number[] => [...constant(a, 30), ...constant(b, 30)];

describe('saturation (USE)', () => {
  it('flags a pool at 100 % with a growing wait queue, from the first saturated sample', () => {
    const metrics = [
      ...points('db', 'pool_in_use', split(12, 30)),
      ...points('db', 'pool_capacity', constant(30)),
      ...points('db', 'pool_wait_queue', split(0, 200)),
    ];
    const [pool] = analyzeSaturation(metrics, [], { baseline: BASE, window: WIN });
    expect(pool).toMatchObject({
      resource: 'db.pool',
      status: 'saturated',
      saturatedFromUs: at(30),
    });
    expect(pool?.capacity).toEqual({ value: 30, source: 'metric' });
    expect(pool?.utilization?.mean).toBe(1);
    expect(pool?.saturatedShare).toBe(1);
  });

  it('does not flag a single sample at 100 % (negative case)', () => {
    const inUse = noise(N, 4, 3).map((n) => Math.round(12 + n));
    inUse[45] = 30;
    const queue = constant(0);
    queue[45] = 1;
    const metrics = [
      ...points('db', 'pool_in_use', inUse),
      ...points('db', 'pool_capacity', constant(30)),
      ...points('db', 'pool_wait_queue', queue),
    ];
    const [pool] = analyzeSaturation(metrics, [], { baseline: BASE, window: WIN });
    expect(pool?.status).toBe('ok');
    expect(pool?.utilization?.max).toBe(1);
  });

  it('reports full utilization without queueing as busy, not saturated', () => {
    const metrics = [
      ...points('db', 'pool_in_use', constant(30)),
      ...points('db', 'pool_capacity', constant(30)),
      ...points('db', 'pool_wait_queue', constant(0)),
    ];
    expect(analyzeSaturation(metrics, [], { baseline: BASE, window: WIN })[0]?.status).toBe('busy');
  });

  it('infers worker capacity from concurrency while queueing, and says when it cannot', () => {
    const metrics = [
      ...points('checkout', 'in_flight', split(6, 60)),
      ...points('checkout', 'queue_depth', split(0, 40)),
      ...points('payment', 'in_flight', constant(3)),
      ...points('payment', 'queue_depth', constant(0)),
    ];
    const [checkout, payment] = analyzeSaturation(metrics, [], { baseline: BASE, window: WIN });
    expect(checkout).toMatchObject({ resource: 'checkout.workers', status: 'saturated' });
    expect(checkout?.capacity).toEqual({ value: 60, source: 'inferred-from-queueing' });
    expect(payment).toMatchObject({
      resource: 'payment.workers',
      status: 'unknown-capacity',
      utilization: null,
    });
  });
});

describe('hold-and-wait', () => {
  const dbMetrics = (inUse: number, active: number) => [
    ...points('db', 'pool_in_use', constant(inUse)),
    ...points('db', 'pool_capacity', constant(10)),
    ...points('db', 'db_active_queries', constant(active)),
    ...points('db', 'queue_depth', constant(0)),
  ];
  const traces = (waitUs: number) =>
    Array.from({ length: 10 }, (_, i) =>
      checkoutTrace(at(31) + i * TICK, { acquireWaitUs: waitUs }).tree(),
    );

  it('detects connections held idle while their holders wait for more connections', () => {
    const r = analyzeHoldAndWait(dbMetrics(10, 1), traces(2_000 * MS), WIN);
    expect(r.detected).toBe(true);
    expect(r.pool.medianIdleHeldFraction).toBe(0.9);
    expect(r.transactions.nestedWaitShare).toBeGreaterThan(0.9);
    expect(r.transactions.holders[0]?.service).toBe('checkout');
    expect(r.transactions.waiters[0]?.service).toBe('inventory');
    expect(r.transactions.evidenceIds.length).toBeGreaterThan(0);
    expect(r.pool.evidenceIds.length).toBeGreaterThan(0);
  });

  it('does not detect it in a healthy system (negative case)', () => {
    const r = analyzeHoldAndWait(dbMetrics(4, 3), traces(0), WIN);
    expect(r.detected).toBe(false);
    expect(r.criteria.map((c) => c.met)).toEqual([false, false, false]);
  });

  it('does not detect it when the pool is full of executing queries (a busy DB, not hold-and-wait)', () => {
    const r = analyzeHoldAndWait(dbMetrics(10, 10), traces(0), WIN);
    expect(r.criteria.map((c) => c.met)).toEqual([true, false, false]);
    expect(r.detected).toBe(false);
  });
});
