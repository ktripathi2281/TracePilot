// Cache effectiveness per service, from the cache_hit_ratio metric: hit ratio in a window against
// the baseline, and when it first dropped. Pure; reads only the series passed in.

import { findSeries, inWindow, type Series, type Window } from './series.ts';
import { quantile } from './stats.ts';

export interface CacheStats {
  service: string;
  baselineMedian: number;
  windowMedian: number;
  /** Hit ratio fell by at least `dropThreshold` (absolute) against the baseline median. */
  degraded: boolean;
  /** First sample in the window below baseline − threshold, or null. */
  firstDropUs: number | null;
  firstDropEvidenceId: string | null;
  evidenceIds: string[];
}

export function analyzeCaches(
  series: readonly Series[],
  opts: { baseline: Window; window: Window; dropThreshold?: number },
): CacheStats[] {
  const threshold = opts.dropThreshold ?? 0.2;
  const services = [
    ...new Set(series.filter((s) => s.name === 'cache_hit_ratio').map((s) => s.service)),
  ].sort();
  return services.flatMap((service) => {
    const s = findSeries(series, service, 'cache_hit_ratio');
    if (s === undefined) return [];
    const base = s.points.filter((p) => inWindow(p.ts, opts.baseline));
    const win = s.points.filter((p) => inWindow(p.ts, opts.window));
    if (base.length === 0 || win.length === 0) return [];
    const baselineMedian = quantile(
      base.map((p) => p.value),
      0.5,
    );
    const windowMedian = quantile(
      win.map((p) => p.value),
      0.5,
    );
    const first = win.find((p) => p.value < baselineMedian - threshold);
    return [
      {
        service,
        baselineMedian,
        windowMedian,
        degraded: windowMedian < baselineMedian - threshold,
        firstDropUs: first?.ts ?? null,
        firstDropEvidenceId: first?.evidenceId ?? null,
        evidenceIds: [
          ...new Set(
            [base.at(-1)?.evidenceId, first?.evidenceId, win.at(-1)?.evidenceId].filter(
              (x): x is string => x !== undefined,
            ),
          ),
        ],
      },
    ];
  });
}
