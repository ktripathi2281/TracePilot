/**
 * @tracepilot/sim — deterministic discrete-event simulator (brief §3) and scenarios (§5).
 *
 * Public entry point. `packages/agents`, `packages/analysis` and `packages/store` must never
 * import this package (enforced by ESLint): the investigator only sees telemetry.
 */
export * from './model.ts';
export * from './engine.ts';
export * from './knobs.ts';
export * from './workload.ts';
export * from './hash.ts';
export * from './summary.ts';
export * from './scenarios/index.ts';
export * from './scenarios/pool-exhaustion.ts';
export * from './scenarios/bad-rollout-oomkill.ts';
export * from './scenarios/retry-storm.ts';
export { uniform, sampleDist, mulberry32 } from './rng.ts';
export { percentile } from './util.ts';
