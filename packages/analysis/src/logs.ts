// Error-log bursts, for the timeline (brief §4.1).
//
// Warn/error logs are grouped by (service, level, template), where the template is the message
// with numbers replaced by `N`. Counts per bucket are compared with the group's baseline rate. A
// bucket is active at or above max(minCount, 3 × baseline mean + 1). A burst is at least
// `persistence` active buckets, each within `maxGapBuckets` quiet buckets of the next.

import type { LogRecord } from '@tracepilot/schema';
import { inWindow, type Window } from './series.ts';

export interface LogBurstOptions {
  baseline: Window;
  /** Bucket size; use the metric tick. */
  bucketUs: number;
  /** Buckets at or above threshold needed for a burst. Default 3. */
  persistence?: number;
  /**
   * Quieter buckets allowed between active ones. Request logs are trace-sampled, so a real
   * burst shows up as scattered buckets. Default 3.
   */
  maxGapBuckets?: number;
  /** Minimum count per bucket. Default 1. */
  minCount?: number;
  /** Levels considered. Default warn + error. */
  levels?: readonly LogRecord['level'][];
}

export interface LogBurst {
  service: string;
  level: LogRecord['level'];
  template: string;
  startUs: number;
  /** End of the last bucket of the burst; null if it lasts to the end of the data. */
  endUs: number | null;
  count: number;
  /** Buckets at or above threshold within the burst. */
  activeBuckets: number;
  peakPerBucket: number;
  baselinePerBucket: number;
  threshold: number;
  /** First log of the burst, then up to 4 more. */
  evidenceIds: string[];
}

export const logTemplate = (message: string): string => message.replace(/\d+(\.\d+)?/g, 'N');

export function detectLogBursts(logs: readonly LogRecord[], opts: LogBurstOptions): LogBurst[] {
  const persistence = opts.persistence ?? 3;
  const maxGap = opts.maxGapBuckets ?? 3;
  const minCount = opts.minCount ?? 1;
  const levels = new Set(opts.levels ?? ['warn', 'error']);
  const groups = new Map<string, LogRecord[]>();
  for (const l of logs) {
    if (!levels.has(l.level)) continue;
    const key = `${l.service}|${l.level}|${logTemplate(l.message)}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [l]);
    else g.push(l);
  }
  if (logs.length === 0) return [];
  const lastTs = Math.max(...logs.map((l) => l.ts));
  const baseBuckets = Math.max(
    1,
    Math.round((opts.baseline.toUs - opts.baseline.fromUs) / opts.bucketUs),
  );
  const bucketOf = (ts: number): number => Math.floor(ts / opts.bucketUs);
  const lastBucket = bucketOf(lastTs);

  const bursts: LogBurst[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [service = '', level = 'warn', template = ''] = key.split('|');
    group.sort((a, b) => a.ts - b.ts);
    const baseCount = group.filter((l) => inWindow(l.ts, opts.baseline)).length;
    const baselinePerBucket = baseCount / baseBuckets;
    const threshold = Math.max(minCount, Math.ceil(3 * baselinePerBucket + 1));
    const counts = new Map<number, LogRecord[]>();
    for (const l of group) {
      const b = bucketOf(l.ts);
      const c = counts.get(b);
      if (c === undefined) counts.set(b, [l]);
      else c.push(l);
    }
    // Buckets at or above threshold, merged when separated by at most maxGap quieter buckets.
    const hot = [...counts.entries()]
      .filter(([, c]) => c.length >= threshold)
      .map(([k]) => k)
      .sort((x, y) => x - y);
    let i = 0;
    while (i < hot.length) {
      let j = i;
      while (j + 1 < hot.length && (hot[j + 1] as number) - (hot[j] as number) <= maxGap + 1) j++;
      const hotCount = j - i + 1;
      if (hotCount >= persistence) {
        const start = hot[i] as number;
        const end = hot[j] as number;
        const inBurst: LogRecord[] = [];
        for (let k = start; k <= end; k++) inBurst.push(...(counts.get(k) ?? []));
        bursts.push({
          service,
          level: level as LogRecord['level'],
          template,
          startUs: (inBurst[0] as LogRecord).ts,
          endUs: lastBucket - end <= maxGap ? null : (end + 1) * opts.bucketUs,
          count: inBurst.length,
          activeBuckets: hotCount,
          peakPerBucket: Math.max(...hot.slice(i, j + 1).map((k) => counts.get(k)?.length ?? 0)),
          baselinePerBucket: Math.round(baselinePerBucket * 1000) / 1000,
          threshold,
          evidenceIds: inBurst.slice(0, 5).map((l) => l.id),
        });
      }
      i = j + 1;
    }
  }
  return bursts.sort((a, b) => a.startUs - b.startUs || (a.service < b.service ? -1 : 1));
}
