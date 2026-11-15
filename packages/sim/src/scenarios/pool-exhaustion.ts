// Scenario A: DB connection-pool exhaustion after a deploy (brief §5).
//
// Topology: api-gateway → checkout → (inventory, payment) → db, with ONE connection pool shared
// by checkout, inventory and payment.
//
// Mechanism (nothing here is scripted; it emerges from the model):
// - checkout wraps an order in a DB transaction and keeps that connection while it calls
//   inventory and payment, which need connections from the SAME pool (hold-and-wait).
// - Before the deploy checkout has 20 workers, so it can hold at most 20 of the 30 connections;
//   at least 10 always remain for the downstream queries. The system cannot jam.
// - checkout v2.4.1 raises workers 20 → 60 and reserves stock with 4 parallel inventory calls
//   instead of 1. Connection demand rises close to the pool size, queries start waiting, waiting
//   keeps transactions open longer, open transactions hold more connections... and with 60
//   workers checkout can now hold all 30 connections while its own downstream queries starve.
//
// Red herrings (both real, neither causal):
// 1. ev_1: an inventory timeout tweak 3.5 minutes before the deploy. A real knob with no effect,
//    because no inventory request gets anywhere near either limit.
// 2. A 20 s slowdown of the external payment provider 3 minutes before the deploy. It briefly
//    raises payment and checkout latency and pool usage, then resolves by itself.

import { US_PER_MIN, US_PER_MS, US_PER_S, type ChangeEvent } from '@tracepilot/schema';
import type { Dist, Recording, SimConfig } from '../model.ts';
import { generateWorkload, type WorkloadSpec } from '../workload.ts';

const ms = (x: number): number => Math.round(x * US_PER_MS);
const ln = (medianMs: number, sigma: number): Dist => ({
  kind: 'lognormal',
  medianUs: ms(medianMs),
  sigma,
});

export const POOL_EXHAUSTION = 'pool-exhaustion';

export const POOL_EXHAUSTION_TIMES = {
  inventoryTweakUs: 6.5 * US_PER_MIN,
  paymentBlipStartUs: 7 * US_PER_MIN,
  paymentBlipEndUs: 7 * US_PER_MIN + 20 * US_PER_S,
  deployUs: 10 * US_PER_MIN,
  durationUs: 15 * US_PER_MIN,
} as const;

export const POOL_EXHAUSTION_CHANGE_IDS = {
  inventoryTweak: 'ev_1',
  checkoutDeploy: 'ev_2',
} as const;

export interface PoolExhaustionOptions {
  /** Total simulated time. Default 15 min (10 min baseline + 5 min incident). */
  durationUs?: number;
  /** Include the checkout v2.4.1 deploy. Default true. */
  deploy?: boolean;
  /** Include the two red herrings. Default true. */
  redHerrings?: boolean;
  traceSampleRate?: number;
}

export function poolExhaustionConfig(options: PoolExhaustionOptions = {}): SimConfig {
  const T = POOL_EXHAUSTION_TIMES;
  const changes: ChangeEvent[] = [];
  if (options.redHerrings !== false) {
    changes.push({
      id: POOL_EXHAUSTION_CHANGE_IDS.inventoryTweak,
      ts: T.inventoryTweakUs,
      kind: 'config',
      service: 'inventory',
      description: 'inventory: raise request timeout 6s -> 8s',
      diff: { timeoutUs: { from: 6 * US_PER_S, to: 8 * US_PER_S } },
    });
  }
  if (options.deploy !== false) {
    changes.push({
      id: POOL_EXHAUSTION_CHANGE_IDS.checkoutDeploy,
      ts: T.deployUs,
      kind: 'deploy',
      service: 'checkout',
      description: 'checkout v2.4.1: parallel per-warehouse stock reservation, larger worker pool',
      diff: {
        version: { from: '2.4.0', to: '2.4.1' },
        workers: { from: 20, to: 60 },
        'params.reserveFanout': { from: 1, to: 4 },
      },
    });
  }
  return {
    scenario: POOL_EXHAUSTION,
    durationUs: options.durationUs ?? T.durationUs,
    model: {
      requestTypes: {
        checkout: { service: 'api-gateway', operation: 'checkout' },
        stock: { service: 'api-gateway', operation: 'stock' },
      },
      services: {
        'api-gateway': {
          replicas: 2,
          workers: 512,
          queueLimit: 1024,
          timeoutUs: 30 * US_PER_S,
          params: {},
          operations: {
            checkout: {
              steps: [
                { kind: 'compute', label: 'route', dist: ln(1.5, 0.2) },
                {
                  kind: 'call',
                  label: 'place-order',
                  service: 'checkout',
                  operation: 'place-order',
                },
                { kind: 'compute', label: 'respond', dist: ln(0.3, 0.2) },
              ],
            },
            stock: {
              steps: [
                { kind: 'compute', label: 'route', dist: ln(1, 0.2) },
                { kind: 'call', label: 'get-stock', service: 'inventory', operation: 'get-stock' },
              ],
            },
          },
        },
        checkout: {
          replicas: 1,
          workers: 20,
          queueLimit: 40,
          timeoutUs: 20 * US_PER_S,
          params: { reserveFanout: 1 },
          operations: {
            'place-order': {
              steps: [
                { kind: 'compute', label: 'validate', dist: ln(4, 0.25) },
                {
                  kind: 'transaction',
                  label: 'order-tx',
                  steps: [
                    { kind: 'query', label: 'load-cart', dist: ln(6, 0.25) },
                    {
                      kind: 'parallel',
                      label: 'fulfil',
                      branches: [
                        [
                          {
                            kind: 'fanout',
                            label: 'reserve',
                            countParam: 'reserveFanout',
                            steps: [
                              {
                                kind: 'call',
                                label: 'inventory',
                                service: 'inventory',
                                operation: 'reserve',
                              },
                            ],
                          },
                        ],
                        [
                          {
                            kind: 'call',
                            label: 'payment',
                            service: 'payment',
                            operation: 'charge',
                          },
                        ],
                      ],
                    },
                    { kind: 'query', label: 'insert-order', dist: ln(8, 0.25) },
                  ],
                },
                { kind: 'compute', label: 'serialize', dist: ln(1, 0.2) },
              ],
            },
          },
        },
        inventory: {
          replicas: 2,
          workers: 256,
          queueLimit: 512,
          timeoutUs: 6 * US_PER_S,
          params: {},
          operations: {
            reserve: {
              steps: [
                { kind: 'compute', label: 'check', dist: ln(2, 0.25) },
                { kind: 'query', label: 'reserve-stock', dist: ln(55, 0.3) },
              ],
            },
            'get-stock': {
              steps: [
                { kind: 'compute', label: 'parse', dist: ln(1, 0.25) },
                { kind: 'query', label: 'read-stock', dist: ln(12, 0.3) },
              ],
            },
          },
        },
        payment: {
          replicas: 2,
          workers: 64,
          queueLimit: 128,
          timeoutUs: 8 * US_PER_S,
          params: {},
          operations: {
            charge: {
              steps: [
                { kind: 'compute', label: 'prepare', dist: ln(3, 0.25) },
                { kind: 'query', label: 'insert-payment', dist: ln(6, 0.25) },
                {
                  kind: 'external',
                  label: 'provider.authorize',
                  peer: 'payment-provider',
                  dist: ln(25, 0.4),
                  slowLogThresholdUs: ms(90),
                },
                { kind: 'query', label: 'update-payment', dist: ln(6, 0.25) },
              ],
            },
          },
        },
      },
      db: { pool: { capacity: 30 }, acquireTimeoutUs: 5 * US_PER_S, maxParallelQueries: 24 },
    },
    changes,
    disturbances:
      options.redHerrings !== false
        ? [
            {
              description: 'payment provider degraded',
              startUs: T.paymentBlipStartUs,
              endUs: T.paymentBlipEndUs,
              service: 'payment',
              step: 'provider.authorize',
              factor: 5,
            },
          ]
        : [],
    pins: [],
    options: {
      traceSampleRate: options.traceSampleRate ?? 0.05,
      metricIntervalUs: 5 * US_PER_S,
      noiseLogMeanIntervalUs: 8 * US_PER_S,
    },
  };
}

export function poolExhaustionWorkloadSpec(durationUs: number): WorkloadSpec {
  return { durationUs, types: { checkout: { ratePerS: 80 }, stock: { ratePerS: 40 } } };
}

/** Generates the workload and returns a complete, replayable recording. */
export function recordPoolExhaustion(seed: number, options: PoolExhaustionOptions = {}): Recording {
  const config = poolExhaustionConfig(options);
  return {
    formatVersion: 1,
    config,
    workload: generateWorkload(poolExhaustionWorkloadSpec(config.durationUs), seed),
  };
}
