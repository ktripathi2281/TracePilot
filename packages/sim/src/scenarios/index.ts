import type { Recording } from '../model.ts';
import { POOL_EXHAUSTION, recordPoolExhaustion } from './pool-exhaustion.ts';

/** Scenario name → recording factory. Scenarios B/C/D are added in Phase 6. */
export const SCENARIOS: Readonly<Record<string, (seed: number) => Recording>> = {
  [POOL_EXHAUSTION]: (seed) => recordPoolExhaustion(seed),
};

export function recordScenario(name: string, seed: number): Recording {
  const factory = SCENARIOS[name];
  if (factory === undefined) {
    throw new Error(`unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  return factory(seed);
}
