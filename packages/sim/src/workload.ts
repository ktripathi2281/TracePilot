// Workload generation is a separate step from running the system (brief §3): the same recorded
// arrivals can be replayed against any config.

import { US_PER_S } from '@tracepilot/schema';
import type { Workload, WorkloadRequest } from './model.ts';
import { hashString, mulberry32 } from './rng.ts';

export interface WorkloadSpec {
  /** Arrivals are generated in [0, durationUs). */
  durationUs: number;
  /** Independent Poisson arrival process per request type. */
  types: Readonly<Record<string, { ratePerS: number }>>;
}

export function generateWorkload(spec: WorkloadSpec, seed: number): Workload {
  const arrivals: Omit<WorkloadRequest, 'requestId'>[] = [];
  for (const type of Object.keys(spec.types).sort()) {
    const rate = spec.types[type]?.ratePerS ?? 0;
    if (!(rate > 0)) continue;
    const next = mulberry32(hashString(`workload/${type}`, seed));
    let t = 0;
    for (;;) {
      t += Math.max(1, Math.round((-Math.log(1 - next()) / rate) * US_PER_S));
      if (t >= spec.durationUs) break;
      arrivals.push({ arrivalUs: t, type });
    }
  }
  arrivals.sort(
    (a, b) => a.arrivalUs - b.arrivalUs || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
  );
  return {
    seed,
    requests: arrivals.map((a, requestId) => ({ requestId, arrivalUs: a.arrivalUs, type: a.type })),
  };
}
