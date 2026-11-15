// Robust statistics. Pure, deterministic.

/** Linear-interpolated quantile (R type 7) of an ASCENDING sorted array. q in [0, 1]. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) throw new Error('quantile of an empty set');
  if (n === 1) return sorted[0] as number;
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (h - lo) * (b - a);
}

export function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function quantile(values: readonly number[], q: number): number {
  return quantileSorted(sortedCopy(values), q);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('mean of an empty set');
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Scale factor that makes the MAD a consistent estimator of sigma for normal data. */
export const MAD_TO_SIGMA = 1.4826;

export interface RobustStats {
  count: number;
  median: number;
  /** Median absolute deviation from the median. */
  mad: number;
  /** 1.4826 × MAD: robust standard deviation. */
  sigma: number;
  p05: number;
  p95: number;
}

export function robustStats(values: readonly number[]): RobustStats {
  const sorted = sortedCopy(values);
  const med = quantileSorted(sorted, 0.5);
  const mad = median(sorted.map((v) => Math.abs(v - med)));
  return {
    count: sorted.length,
    median: med,
    mad,
    sigma: MAD_TO_SIGMA * mad,
    p05: quantileSorted(sorted, 0.05),
    p95: quantileSorted(sorted, 0.95),
  };
}

/** Rounds to 3 decimals so reported numbers are stable and comparable. */
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * The items that DEFINE the median of `items` by `value`: one item for an odd count, the two
 * middle items for an even count. Lets every reported median cite concrete evidence.
 */
export function medianItems<T>(items: readonly T[], value: (t: T) => number): T[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => value(a) - value(b));
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? [sorted[mid] as T] : [sorted[mid - 1] as T, sorted[mid] as T];
}
