/**
 * @tracepilot/analysis — pure deterministic analyzers (brief §4).
 *
 * Functions over telemetry returned by the store. No LLM, no I/O, no clock, no randomness, and
 * no access to simulator configuration (all enforced by lint). Every number they return comes
 * with the evidence IDs it was computed from.
 */
export * from './stats.ts';
export * from './series.ts';
export * from './traces.ts';
export * from './anomaly.ts';
export * from './precedence.ts';
export * from './graph.ts';
export * from './attribution.ts';
export * from './saturation.ts';
export * from './holdwait.ts';
export * from './propagation.ts';
export * from './changes.ts';
export * from './logs.ts';
export * from './compare.ts';
export * from './timeline.ts';
export * from './windows.ts';
export * from './onsets.ts';
export * from './pods.ts';
export * from './retries.ts';
export * from './caches.ts';
