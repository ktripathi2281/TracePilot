// Scenario C: a deploy changes a cache key and the hit rate collapses (brief §5).
//
// Same topology as scenario A. inventory serves stock lookups through a cache (cache-aside): a hit
// costs about a millisecond, a miss runs two DB queries (stock and prices). This checkout version
// releases its DB connection around downstream calls (no hold-and-wait, unlike scenario A).
//
// Mechanism (nothing scripted; it emerges from the model):
// - The cache holds 20,000 entries; stock lookups use about 21,000 distinct keys, so about 95 % of
//   them hit and the database sees few stock reads.
// - inventory v1.9.0 adds the warehouse and customer segment to the cache key: about 400,000
//   distinct keys. Every cached entry is useless at once (new key format), and even a full cache
//   holds 5 % of the keys. Nearly every stock lookup now reads the database.
// - The database executes at most 16 queries at a time. Stock reads now take more than that share,
//   queries queue at the executor while holding their connections, latency climbs for every
//   request that touches the database, checkout's included.
//
// Red herrings (scenario A's, both real, neither causal): an inventory timeout tweak (ev_1,
// T+6:30, the same service as the real cause) and a 20 s payment-provider slowdown at T+7:00.

import { US_PER_MIN, US_PER_MS, US_PER_S, type ChangeEvent } from '@tracepilot/schema';
import type { Recording, SimConfig, Step } from '../model.ts';
import { generateWorkload, type WorkloadSpec } from '../workload.ts';
import { poolExhaustionConfig } from './pool-exhaustion.ts';

export const CACHE_HIT_RATE_DROP = 'cache-hit-rate-drop';

export const CACHE_DROP_TIMES = {
  inventoryTweakUs: 6.5 * US_PER_MIN,
  providerBlipStartUs: 7 * US_PER_MIN,
  providerBlipEndUs: 7 * US_PER_MIN + 20 * US_PER_S,
  deployUs: 10 * US_PER_MIN,
  durationUs: 15 * US_PER_MIN,
} as const;

export const CACHE_DROP_CHANGE_IDS = { inventoryTweak: 'ev_1', inventoryDeploy: 'ev_2' } as const;

export const CACHE_DROP_KEYS = { before: 21_000, after: 400_000, capacity: 20_000 } as const;

export interface CacheDropOptions {
  /** Include the inventory v1.9.0 deploy. Default true. */
  deploy?: boolean;
  /** Include the two red herrings. Default true. */
  redHerrings?: boolean;
  traceSampleRate?: number;
}

export function cacheDropWorkloadSpec(durationUs: number): WorkloadSpec {
  return { durationUs, types: { checkout: { ratePerS: 80 }, stock: { ratePerS: 300 } } };
}

const ln = (medianMs: number, sigma: number) => ({
  kind: 'lognormal' as const,
  medianUs: Math.round(medianMs * US_PER_MS),
  sigma,
});

export function cacheDropConfig(options: CacheDropOptions = {}): SimConfig {
  const T = CACHE_DROP_TIMES;
  const base = poolExhaustionConfig({
    deploy: false,
    redHerrings: options.redHerrings !== false,
    durationUs: T.durationUs,
    ...(options.traceSampleRate === undefined ? {} : { traceSampleRate: options.traceSampleRate }),
  });
  const { checkout, inventory } = base.model.services;
  if (checkout === undefined || inventory === undefined)
    throw new Error('scenario base is incomplete');

  // checkout: a version that does not hold its connection across calls.
  const visit = (steps: Step[]): void => {
    for (const s of steps) {
      if (s.kind === 'transaction') s.release = 'around-calls';
      if (s.kind === 'parallel') s.branches.forEach(visit);
      else if (s.kind === 'fanout' || s.kind === 'transaction') visit(s.steps);
    }
  };
  for (const op of Object.values(checkout.operations)) visit(op.steps);

  // inventory: stock lookups through the cache; a miss reads stock and prices.
  inventory.params['stockKeys'] = CACHE_DROP_KEYS.before;
  inventory.operations['get-stock'] = {
    steps: [
      { kind: 'compute', label: 'parse', dist: ln(1, 0.25) },
      {
        kind: 'cache',
        label: 'stock-cache',
        keySpaceParam: 'stockKeys',
        lookup: ln(0.8, 0.3),
        steps: [
          { kind: 'query', label: 'read-stock', dist: ln(12, 0.3) },
          { kind: 'query', label: 'read-prices', dist: ln(25, 0.3) },
        ],
      },
    ],
  };
  base.model.cache = { capacity: CACHE_DROP_KEYS.capacity };
  base.model.db.maxParallelQueries = 16;

  const changes: ChangeEvent[] = [...base.changes];
  if (options.deploy !== false)
    changes.push({
      id: CACHE_DROP_CHANGE_IDS.inventoryDeploy,
      ts: T.deployUs,
      kind: 'deploy',
      service: 'inventory',
      description: 'inventory v1.9.0: stock cache keyed by warehouse and customer segment',
      diff: {
        version: { from: '1.8.2', to: '1.9.0' },
        'params.stockKeys': { from: CACHE_DROP_KEYS.before, to: CACHE_DROP_KEYS.after },
      },
    });
  return { ...base, scenario: CACHE_HIT_RATE_DROP, changes };
}

export function recordCacheDrop(seed: number, options: CacheDropOptions = {}): Recording {
  const config = cacheDropConfig(options);
  return {
    formatVersion: 1,
    config,
    workload: generateWorkload(cacheDropWorkloadSpec(config.durationUs), seed),
  };
}
