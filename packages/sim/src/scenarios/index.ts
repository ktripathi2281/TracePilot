import type { Recording } from '../model.ts';
import { BAD_ROLLOUT_OOMKILL, recordBadRollout } from './bad-rollout-oomkill.ts';
import { POOL_EXHAUSTION, recordPoolExhaustion } from './pool-exhaustion.ts';

/** Scenario name → recording factory. */
export const SCENARIOS: Readonly<Record<string, (seed: number) => Recording>> = {
  [POOL_EXHAUSTION]: (seed) => recordPoolExhaustion(seed),
  [BAD_ROLLOUT_OOMKILL]: (seed) => recordBadRollout(seed),
};

export function recordScenario(name: string, seed: number): Recording {
  const factory = SCENARIOS[name];
  if (factory === undefined) {
    throw new Error(`unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  return factory(seed);
}
