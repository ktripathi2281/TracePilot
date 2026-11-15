// Builders for tiny hand-checkable models used by the tests. Not exported from the package.

import { US_PER_MS, US_PER_S } from '@tracepilot/schema';
import { runSimulation, type RunOptions, type SimResult } from './engine.ts';
import type { Dist, ServiceModel, SimConfig, Step, Workload } from './model.ts';

export const ms = (x: number): number => Math.round(x * US_PER_MS);

/** Constant duration: makes timings exact so tests can assert them to the microsecond. */
export const fixed = (millis: number): Dist => ({ kind: 'constant', valueUs: ms(millis) });

export function service(steps: Step[], over: Partial<ServiceModel> = {}): ServiceModel {
  return {
    replicas: 1,
    workers: 100,
    queueLimit: 100,
    timeoutUs: 60 * US_PER_S,
    params: {},
    operations: { op: { steps } },
    ...over,
  };
}

export interface MicroOptions {
  services: Record<string, ServiceModel>;
  /** Entry service; its operation `op` is the request type `req`. Default: first service. */
  entry?: string;
  pool?: number;
  acquireTimeoutMs?: number;
  maxParallelQueries?: number;
  durationMs?: number;
  changes?: SimConfig['changes'];
  disturbances?: SimConfig['disturbances'];
  pins?: string[];
}

export function microConfig(o: MicroOptions): SimConfig {
  const entry = o.entry ?? (Object.keys(o.services)[0] as string);
  return {
    scenario: 'micro',
    durationUs: ms(o.durationMs ?? 10_000),
    model: {
      services: o.services,
      db: {
        pool: { capacity: o.pool ?? 10 },
        acquireTimeoutUs: ms(o.acquireTimeoutMs ?? 5_000),
        maxParallelQueries: o.maxParallelQueries ?? 100,
      },
      requestTypes: { req: { service: entry, operation: 'op' } },
    },
    changes: o.changes ?? [],
    disturbances: o.disturbances ?? [],
    pins: o.pins ?? [],
    options: { traceSampleRate: 1, metricIntervalUs: 5 * US_PER_S, noiseLogMeanIntervalUs: 0 },
  };
}

/** Requests of type `req` arriving at the given milliseconds. requestId = index. */
export function arrivals(atMs: number[], seed = 1): Workload {
  return {
    seed,
    requests: atMs.map((t, requestId) => ({ requestId, arrivalUs: ms(t), type: 'req' })),
  };
}

export function runMicro(o: MicroOptions, atMs: number[], opts: RunOptions = {}): SimResult {
  return runSimulation(microConfig(o), arrivals(atMs), opts);
}

/** End time in ms and status of each request, ordered by requestId. */
export function ends(r: SimResult): [number, string][] {
  return [...r.outcomes]
    .sort((a, b) => a.requestId - b.requestId)
    .map((o) => [o.endUs / US_PER_MS, o.status]);
}
