// Scenario D: a bad rollout that gets pods OOMKilled (brief §5, Kubernetes-flavored, simulated).
//
// Same system as scenario A (api-gateway → checkout → (inventory, payment) → db, one shared pool),
// with checkout running as 3 pods that each have a memory limit (pod lifecycle model, model.ts).
//
// Mechanism (nothing scripted; it emerges from the model):
// - A checkout pod uses 300 MiB plus 6 MiB per request it is processing; its limit is 512 MiB.
//   At baseline a pod processes a few requests at a time and stays far below the limit.
// - The checkout v2.5.0 rollout builds a per-request pricing cache: 40 MiB per request. Now a pod
//   dies as soon as it processes six requests at once. Ordinary bursts do that: a pod is
//   OOMKilled, its requests fail, it restarts after a back-off, and meanwhile the remaining pods
//   take its traffic, process more requests at once, and die in turn (CrashLoopBackOff).
// - The connection pool is NOT the bottleneck: checkout's concurrency is limited by its pods'
//   memory, not by connections. That is the discriminating evidence against scenario A's pattern.
//
// Red herrings (all real, none causal):
// 1. ev_1: a payment timeout change at T+6:00 (8 s → 10 s). No payment request comes near either.
// 2. A 20 s slowdown of inventory's stock-reservation query at T+7:30. It raises latency and pool
//    usage briefly (it looks like the start of scenario A), then resolves by itself.
// 3. ev_3: an inventory queue-limit change at T+10:40, AFTER the incident began. Real, harmless.

import { US_PER_MIN, US_PER_S, type ChangeEvent } from '@tracepilot/schema';
import type { PodModel, Recording, SimConfig } from '../model.ts';
import { generateWorkload } from '../workload.ts';
import { poolExhaustionConfig, poolExhaustionWorkloadSpec } from './pool-exhaustion.ts';

export const BAD_ROLLOUT_OOMKILL = 'bad-rollout-oomkill';

const MiB = 1_048_576;

export const BAD_ROLLOUT_TIMES = {
  paymentTweakUs: 6 * US_PER_MIN,
  dbBlipStartUs: 7.5 * US_PER_MIN,
  dbBlipEndUs: 7.5 * US_PER_MIN + 20 * US_PER_S,
  rolloutUs: 10 * US_PER_MIN,
  inventoryTweakUs: 10 * US_PER_MIN + 40 * US_PER_S,
  durationUs: 15 * US_PER_MIN,
} as const;

export const BAD_ROLLOUT_CHANGE_IDS = {
  paymentTweak: 'ev_1',
  checkoutRollout: 'ev_2',
  inventoryTweak: 'ev_3',
} as const;

export const CHECKOUT_PODS: PodModel = {
  memoryBaseBytes: 300 * MiB,
  memoryPerRequestBytes: 6 * MiB,
  memoryLimitBytes: 512 * MiB,
  restartBackoffUs: 10 * US_PER_S,
  maxBackoffUs: 160 * US_PER_S,
  startupUs: 5 * US_PER_S,
  backoffResetUs: 10 * US_PER_MIN,
};

export interface BadRolloutOptions {
  /** Include the checkout v2.5.0 rollout. Default true. */
  rollout?: boolean;
  /** Include the three red herrings. Default true. */
  redHerrings?: boolean;
  traceSampleRate?: number;
}

export function badRolloutConfig(options: BadRolloutOptions = {}): SimConfig {
  const T = BAD_ROLLOUT_TIMES;
  const base = poolExhaustionConfig({
    deploy: false,
    redHerrings: false,
    durationUs: T.durationUs,
    ...(options.traceSampleRate === undefined ? {} : { traceSampleRate: options.traceSampleRate }),
  });
  const checkout = base.model.services['checkout'];
  if (checkout === undefined) throw new Error('scenario base has no checkout service');
  // 3 pods × 6 workers: 18 in total, under the 20 that keep the pool from jamming (scenario A).
  // With 60 workers the DB-latency blip below sets off scenario A's hold-and-wait jam on its own.
  checkout.replicas = 3;
  checkout.workers = 6;
  checkout.queueLimit = 14;
  checkout.pods = { ...CHECKOUT_PODS };

  const herrings = options.redHerrings !== false;
  const changes: ChangeEvent[] = [];
  if (herrings)
    changes.push({
      id: BAD_ROLLOUT_CHANGE_IDS.paymentTweak,
      ts: T.paymentTweakUs,
      kind: 'config',
      service: 'payment',
      description: 'payment: raise request timeout 8s -> 10s',
      diff: { timeoutUs: { from: 8 * US_PER_S, to: 10 * US_PER_S } },
    });
  if (options.rollout !== false)
    changes.push({
      id: BAD_ROLLOUT_CHANGE_IDS.checkoutRollout,
      ts: T.rolloutUs,
      kind: 'rollout',
      service: 'checkout',
      description: 'checkout v2.5.0: per-request pricing cache',
      diff: {
        version: { from: '2.4.0', to: '2.5.0' },
        memoryPerRequest: { from: 6 * MiB, to: 40 * MiB },
      },
    });
  if (herrings)
    changes.push({
      id: BAD_ROLLOUT_CHANGE_IDS.inventoryTweak,
      ts: T.inventoryTweakUs,
      kind: 'config',
      service: 'inventory',
      description: 'inventory: raise queue limit 512 -> 600',
      diff: { queueLimit: { from: 512, to: 600 } },
    });

  return {
    ...base,
    scenario: BAD_ROLLOUT_OOMKILL,
    changes,
    disturbances: herrings
      ? [
          {
            description: 'stock reservation query slowed',
            startUs: T.dbBlipStartUs,
            endUs: T.dbBlipEndUs,
            service: 'inventory',
            step: 'reserve-stock',
            factor: 4,
          },
        ]
      : [],
  };
}

export function recordBadRollout(seed: number, options: BadRolloutOptions = {}): Recording {
  const config = badRolloutConfig(options);
  return {
    formatVersion: 1,
    config,
    workload: generateWorkload(poolExhaustionWorkloadSpec(config.durationUs), seed),
  };
}
