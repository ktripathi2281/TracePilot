/**
 * @tracepilot/replay — counterfactual replay and sweeps (brief §7).
 *
 * Simulator side: it reads an incident's private recording and runs the simulator. The agents,
 * the store and the analysis library must never import it (enforced by ESLint).
 */
export * from './notice.ts';
export * from './recording.ts';
export * from './summary.ts';
export * from './replay.ts';
export * from './diagnosis.ts';
