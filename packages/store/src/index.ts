/**
 * @tracepilot/store — SQLite telemetry store and typed query API (brief §1, §2).
 *
 * The only way agents and analyzers read telemetry. Holds telemetry only: no simulator config,
 * no recordings, no scenario names, no ground truth. Incidents have neutral, hash-derived IDs.
 */
export * from './store.ts';
