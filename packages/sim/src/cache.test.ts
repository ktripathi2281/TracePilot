// Cache model (brief §5, Scenario C) on micro models. Hit probability = entries / key space;
// each miss fills one entry up to the capacity; a new key space (key format) empties the cache.

import { describe, expect, it } from 'vitest';
import type { ServiceModel } from './model.ts';
import { metricSeries } from './summary.ts';
import { fixed, ms, runMicro, service } from './testkit.ts';
import { applyPatches } from './knobs.ts';
import { microConfig, arrivals } from './testkit.ts';
import { runSimulation } from './engine.ts';

const cached = (keySpace: number): ServiceModel =>
  service(
    [
      {
        kind: 'cache',
        label: 'stock',
        keySpaceParam: 'keySpace',
        lookup: fixed(1),
        steps: [{ kind: 'query', label: 'read', dist: fixed(10) }],
      },
    ],
    { params: { keySpace } },
  );
const many = (n: number, everyMs: number, fromMs = 0): number[] =>
  Array.from({ length: n }, (_, i) => fromMs + i * everyMs);

describe('cache', () => {
  it('a cache that holds every key serves every lookup', () => {
    const r = runMicro(
      { services: { api: cached(100) }, cache: { capacity: 1_000 } },
      many(50, 20),
    );
    expect(r.telemetry.spans.filter((s) => s.name === 'db.query')).toEqual([]);
    const hits = r.telemetry.spans
      .filter((s) => s.name === 'cache.get')
      .map((s) => s.attributes['cache.hit']);
    expect(hits.every((h) => h === true)).toBe(true);
    expect(r.outcomes.every((o) => o.endUs - o.arrivalUs === ms(1))).toBe(true);
  });

  it('hit ratio follows capacity / key space; misses run the backing query', () => {
    const r = runMicro(
      { services: { api: cached(1_000) }, cache: { capacity: 250 }, durationMs: 40_000 },
      many(2_000, 20),
    );
    const ratio = metricSeries(r.telemetry.metrics, 'api', 'cache_hit_ratio').map((p) => p.value);
    const mean = ratio.reduce((a, b) => a + b, 0) / ratio.length;
    expect(mean).toBeGreaterThan(0.18);
    expect(mean).toBeLessThan(0.32);
    const misses = r.telemetry.spans.filter(
      (s) => s.name === 'cache.get' && s.attributes['cache.hit'] === false,
    ).length;
    expect(r.telemetry.spans.filter((s) => s.name === 'db.query').length).toBe(misses);
  });

  it('a change of key space empties the cache, which refills one miss at a time', () => {
    const change = {
      id: 'ev_1',
      ts: ms(10_000),
      kind: 'deploy' as const,
      service: 'api',
      description: 'new cache key',
      diff: { 'params.keySpace': { from: 100, to: 200 } },
    };
    const r = runMicro(
      {
        services: { api: cached(100) },
        cache: { capacity: 1_000 },
        changes: [change],
        durationMs: 30_000,
      },
      many(1_400, 20),
    );
    const ratio = metricSeries(r.telemetry.metrics, 'api', 'cache_hit_ratio');
    expect(ratio.filter((p) => p.ts <= ms(10_000)).every((p) => p.value === 1)).toBe(true);
    // Right after the change most lookups miss; as misses fill the 200 new keys it recovers.
    expect(ratio.find((p) => p.ts === ms(15_000))?.value).toBeLessThan(0.6);
    expect(ratio.at(-1)?.value).toBeGreaterThan(0.9);
  });

  it('cache.capacity is a knob; it is refused where no cache is modeled', () => {
    const config = microConfig({
      services: { api: cached(1_000) },
      cache: { capacity: 100 },
      durationMs: 20_000,
    });
    const bigger = applyPatches(config, [{ target: 'cache.capacity', to: 1_000 }]);
    expect(bigger.model.cache?.capacity).toBe(1_000);
    const r = runSimulation(bigger, arrivals(many(500, 20)));
    expect(r.telemetry.spans.filter((s) => s.name === 'db.query')).toEqual([]);
    const plain = microConfig({
      services: { api: service([{ kind: 'compute', label: 'w', dist: fixed(1) }]) },
    });
    expect(() => applyPatches(plain, [{ target: 'cache.capacity', to: 10 }])).toThrow(
      /no cache is modeled/,
    );
  });

  it('draws hits from the request’s own random stream: the same workload gives the same hits', () => {
    const run = () =>
      runMicro({ services: { api: cached(1_000) }, cache: { capacity: 300 } }, many(300, 20))
        .telemetry.spans.filter((s) => s.name === 'cache.get')
        .map((s) => s.attributes['cache.hit']);
    expect(run()).toEqual(run());
  });
});
