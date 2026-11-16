// Scenario B: a slow dependency and a retry storm (brief §5).
//
// Same topology as scenario A. This checkout version already releases its DB connection around
// downstream calls (no hold-and-wait), and it retries a failed payment call up to 3 times.
//
// Mechanism (nothing scripted; it emerges from the model):
// - payment answers within its own 1.5 s deadline or returns 504.
// - The payment v3.2.0 deploy adds a synchronous fraud screening call (an external service, about
//   0.9 s median) to every charge. Charges now often exceed 1.5 s and time out.
// - checkout retries each timed-out charge, so payment receives up to three times the work while it
//   is already slow: its workers fill, requests queue, more time out, more are retried.
// - checkout's workers are held through every attempt and back-off, so checkout runs out of
//   workers, its queue fills and it rejects requests: the gateway returns errors for checkout.
//
// Red herrings (the same as scenario A's, both real, neither causal): an inventory timeout tweak
// (ev_1, T+6:30) and a 20 s payment-provider slowdown at T+7:00 that resolves by itself.

import { US_PER_MIN, US_PER_MS, US_PER_S, type ChangeEvent } from '@tracepilot/schema';
import type { Recording, SimConfig, Step } from '../model.ts';
import { generateWorkload } from '../workload.ts';
import { poolExhaustionConfig, poolExhaustionWorkloadSpec } from './pool-exhaustion.ts';

export const RETRY_STORM = 'slow-dependency-retry-storm';

export const RETRY_STORM_TIMES = {
  inventoryTweakUs: 6.5 * US_PER_MIN,
  providerBlipStartUs: 7 * US_PER_MIN,
  providerBlipEndUs: 7 * US_PER_MIN + 20 * US_PER_S,
  deployUs: 10 * US_PER_MIN,
  durationUs: 15 * US_PER_MIN,
} as const;

export const RETRY_STORM_CHANGE_IDS = { inventoryTweak: 'ev_1', paymentDeploy: 'ev_2' } as const;

export interface RetryStormOptions {
  /** Include the payment v3.2.0 deploy. Default true. */
  deploy?: boolean;
  /** Include the two red herrings. Default true. */
  redHerrings?: boolean;
  traceSampleRate?: number;
}

export function retryStormConfig(options: RetryStormOptions = {}): SimConfig {
  const T = RETRY_STORM_TIMES;
  const base = poolExhaustionConfig({
    deploy: false,
    redHerrings: options.redHerrings !== false,
    durationUs: T.durationUs,
    ...(options.traceSampleRate === undefined ? {} : { traceSampleRate: options.traceSampleRate }),
  });
  const { checkout, payment } = base.model.services;
  if (checkout === undefined || payment === undefined)
    throw new Error('scenario base is incomplete');

  // checkout: a version that does not hold its connection across calls, and retries payment.
  const visit = (steps: Step[]): void => {
    for (const s of steps) {
      if (s.kind === 'transaction') s.release = 'around-calls';
      if (s.kind === 'call' && s.service === 'payment')
        s.retry = { maxAttempts: 3, backoffUs: 100 * US_PER_MS };
      if (s.kind === 'parallel') s.branches.forEach(visit);
      else if (s.kind === 'fanout' || s.kind === 'transaction') visit(s.steps);
    }
  };
  for (const op of Object.values(checkout.operations)) visit(op.steps);

  // Concurrency: checkout can send enough work to amplify (60 workers; safe from scenario A's
  // jam because this version does not hold connections across calls). payment has 2 × 40 workers:
  // enough for its normal load and for the slower charges alone, not for retried charges on top.
  checkout.workers = 60;
  payment.workers = 40;

  // payment: a 1.5 s deadline, and an (initially disabled) synchronous fraud screening step.
  payment.timeoutUs = 1.5 * US_PER_S;
  payment.params['fraudChecks'] = 0;
  const charge = payment.operations['charge'];
  if (charge === undefined) throw new Error('payment has no charge operation');
  const at = charge.steps.findIndex((s) => s.label === 'provider.authorize');
  charge.steps.splice(at, 0, {
    kind: 'fanout',
    label: 'fraud',
    countParam: 'fraudChecks',
    steps: [
      {
        kind: 'external',
        label: 'fraud.screen',
        peer: 'fraud-service',
        dist: { kind: 'lognormal', medianUs: 900 * US_PER_MS, sigma: 0.45 },
      },
    ],
  });

  const changes: ChangeEvent[] = [...base.changes];
  if (options.deploy !== false)
    changes.push({
      id: RETRY_STORM_CHANGE_IDS.paymentDeploy,
      ts: T.deployUs,
      kind: 'deploy',
      service: 'payment',
      description: 'payment v3.2.0: synchronous fraud screening before authorization',
      diff: {
        version: { from: '3.1.4', to: '3.2.0' },
        'params.fraudChecks': { from: 0, to: 1 },
      },
    });
  return { ...base, scenario: RETRY_STORM, changes };
}

export function recordRetryStorm(seed: number, options: RetryStormOptions = {}): Recording {
  const config = retryStormConfig(options);
  return {
    formatVersion: 1,
    config,
    workload: generateWorkload(poolExhaustionWorkloadSpec(config.durationUs), seed),
  };
}
