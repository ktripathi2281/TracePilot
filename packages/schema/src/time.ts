import { z } from 'zod';

/**
 * All timestamps are VIRTUAL time: integer microseconds since simulation start (brief §2).
 * Never wall-clock time.
 */
export const VirtualTimeUs = z.number().int().nonnegative();
export type VirtualTimeUs = z.infer<typeof VirtualTimeUs>;

/** A non-negative duration in integer microseconds. */
export const DurationUs = z.number().int().nonnegative();
export type DurationUs = z.infer<typeof DurationUs>;

export const US_PER_MS = 1_000;
export const US_PER_S = 1_000_000;
export const US_PER_MIN = 60 * US_PER_S;

/** Metrics are sampled every 5 s of virtual time (brief §2). */
export const METRIC_SAMPLE_INTERVAL_US = 5 * US_PER_S;
