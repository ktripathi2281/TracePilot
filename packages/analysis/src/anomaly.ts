// Anomaly detector (brief §4.2).
//
// Per metric series:
// 1. Baseline: robust statistics (median, MAD → robust sigma) over a baseline window.
// 2. Two thresholds on the deviation from the baseline median, each also bounded below by a
//    relative floor (fraction of |median|) and an absolute floor (per unit), so flat or near-zero
//    baselines (MAD = 0) never flag tiny wiggles:
//      strong   |dev| > z × sigma          (default z = 4)
//      moderate |dev| > z/2 × sigma
// 3. Persistence (control-chart style, cf. the Western Electric rules). An anomaly opens on a run
//    of consecutive samples on the same side beyond the MODERATE threshold that contains either
//      - `persistence` consecutive STRONG samples (default 3), or
//      - at least 2 × `persistence` samples in total (default 6).
//    A single-sample spike, however large, can never open one. This matters for point-sampled
//    gauges: one sample at 30/30 is a moment, five minutes at 30/30 is an incident.
// 4. Hysteresis: an open anomaly closes after `recovery` consecutive samples back inside the
//    moderate threshold (status `recovered`); otherwise it is `ongoing` at the end of the data.
// 5. Onset as an INTERVAL. `onsetUs` is the first sample of the run that made it conclusive;
//    the interval reaches back to the last sample before the run, because moderate samples just
//    before a shift may be noise or the shift itself. A one-sided CUSUM (slack z/2, half the
//    strong shift: the textbook choice) estimates the change point inside that interval.
//
// Every reported number cites the samples it came from.

import type { MetricUnit } from '@tracepilot/schema';
import { inWindow, type Series, type SeriesPoint, type Window } from './series.ts';
import { medianItems, robustStats, round3 } from './stats.ts';

export type Direction = 'up' | 'down';

export interface AnomalyOptions {
  /** Baseline statistics come from samples with ts in this window. */
  baseline: Window;
  /** First sample considered for detection. Default: baseline.fromUs. */
  scanFromUs?: number;
  /** Consecutive strong samples that open an anomaly; twice this many moderate ones also do. Default 3. */
  persistence?: number;
  /** Consecutive normal samples needed to close one. Default = persistence. */
  recovery?: number;
  /** Strong threshold in robust sigmas; the moderate threshold is half of it. Default 4. */
  z?: number;
  /** Minimum |deviation| as a fraction of |baseline median|. Default 0.25. */
  minRelativeChange?: number;
  /** Minimum |deviation| per unit. Defaults in DEFAULT_MIN_ABSOLUTE. */
  minAbsoluteChange?: Partial<Record<MetricUnit, number>>;
}

/** Smallest deviation worth calling a change, per unit (absolute floor). */
export const DEFAULT_MIN_ABSOLUTE: Readonly<Record<MetricUnit, number>> = {
  'req/s': 2,
  ratio: 0.01,
  us: 5_000,
  count: 2,
  bytes: 1_048_576,
};

export interface Anomaly {
  service: string;
  metric: string;
  unit: MetricUnit;
  direction: Direction;
  /**
   * Latest time by which the shift had certainly happened: the first sample of the run that
   * satisfied a persistence rule.
   */
  onsetUs: number;
  /**
   * The shift happened in (onsetUs − onsetResolutionUs, onsetUs]: back to the last sample before
   * the run of exceeding samples. Precedence comparisons use this interval.
   */
  onsetResolutionUs: number;
  /** CUSUM estimate of where the shift began, inside the onset interval. */
  changePointUs: number;
  /** First sample of the run beyond the moderate threshold. */
  firstExceedanceUs: number;
  /** Timestamp of the first sample of the recovery run; null while ongoing. */
  endUs: number | null;
  status: 'ongoing' | 'recovered';
  /** Which persistence rule opened it. */
  rule: 'strong-run' | 'sustained-run';
  /** Samples from onset to the last anomalous sample. */
  samples: number;
  baseline: {
    window: Window;
    median: number;
    mad: number;
    samples: number;
    /** Deviation needed for a strong / moderate sample. */
    strongThreshold: number;
    moderateThreshold: number;
    medianEvidenceIds: string[];
  };
  /** Median and extreme value of the anomalous samples. */
  value: { median: number; peak: number; peakUs: number };
  /** value.median / baseline.median, null when the baseline median is 0. */
  ratio: number | null;
  delta: number;
  confidence: { score: number; level: 'low' | 'medium' | 'high' };
  /** Onset sample, the first samples of the run, peak, end sample. */
  evidenceIds: string[];
}

export interface SkippedSeries {
  service: string;
  metric: string;
  reason: string;
}

export interface AnomalyScan {
  anomalies: Anomaly[];
  skipped: SkippedSeries[];
}

export function detectAnomalies(series: Series, opts: AnomalyOptions): Anomaly[] | SkippedSeries {
  const persistence = opts.persistence ?? 3;
  const recovery = opts.recovery ?? persistence;
  const z = opts.z ?? 4;
  const minRel = opts.minRelativeChange ?? 0.25;
  const minAbs = opts.minAbsoluteChange?.[series.unit] ?? DEFAULT_MIN_ABSOLUTE[series.unit];
  const skip = (reason: string): SkippedSeries => ({
    service: series.service,
    metric: series.name,
    reason,
  });

  const base = series.points.filter((p) => inWindow(p.ts, opts.baseline));
  if (base.length < 2 * persistence) {
    return skip(`only ${String(base.length)} baseline samples (need ${String(2 * persistence)})`);
  }
  const stats = robustStats(base.map((p) => p.value));
  const floor = Math.max(minRel * Math.abs(stats.median), minAbs);
  const strongT = Math.max(z * stats.sigma, floor);
  const moderateT = Math.max((z / 2) * stats.sigma, floor);
  // One "sigma" for standardizing, never below what the floors imply.
  const scale = Math.max(stats.sigma, moderateT / (z / 2));
  const medianEvidenceIds = medianItems(base, (p) => p.value).map((p) => p.evidenceId);

  const scanFrom = opts.scanFromUs ?? opts.baseline.fromUs;
  const pts = series.points.filter((p) => p.ts >= scanFrom);
  const devOf = (p: SeriesPoint): number => p.value - stats.median;
  const side = (p: SeriesPoint): Direction | null => {
    const d = devOf(p);
    return d > moderateT ? 'up' : d < -moderateT ? 'down' : null;
  };
  const strong = (p: SeriesPoint): boolean => Math.abs(devOf(p)) > strongT;

  const anomalies: Anomaly[] = [];
  let i = 0;
  let cusumFrom = 0;
  while (i < pts.length) {
    const d0 = side(pts[i] as SeriesPoint);
    if (d0 === null) {
      i++;
      continue;
    }
    let run = 1;
    while (i + run < pts.length && side(pts[i + run] as SeriesPoint) === d0) run++;
    // Where the run became conclusive: the first of `persistence` consecutive strong samples,
    // or (sustained rule) the start of the run.
    let strongRun = 0;
    let strongStart: number | null = null;
    for (let k = i; k < i + run && strongStart === null; k++) {
      strongRun = strong(pts[k] as SeriesPoint) ? strongRun + 1 : 0;
      if (strongRun >= persistence) strongStart = k - persistence + 1;
    }
    const rule: Anomaly['rule'] | null =
      strongStart !== null ? 'strong-run' : run >= 2 * persistence ? 'sustained-run' : null;
    if (rule === null) {
      i += run;
      continue;
    }
    // Hysteresis: stays open until `recovery` consecutive samples are back inside moderateT.
    let j = i + run;
    let normal = 0;
    let lastIn = i + run - 1;
    let endIdx: number | null = null;
    while (j < pts.length) {
      if (side(pts[j] as SeriesPoint) === d0) {
        normal = 0;
        lastIn = j;
      } else if (++normal >= recovery) {
        endIdx = j - recovery + 1;
        break;
      }
      j++;
    }
    // Onset = where the run became conclusive. Moderate samples before it in the same run could
    // be the start of the shift or noise next to it: they widen the onset interval instead of
    // moving the onset. CUSUM gives the most likely change point inside that interval.
    const onsetIdx = strongStart ?? i;
    const changeIdx = Math.min(
      onsetIdx,
      Math.max(i, cusumOnset(pts, cusumFrom, onsetIdx + 1, stats.median, scale, z / 2, d0)),
    );
    const seg = pts.slice(i, lastIn + 1);
    const inside = seg.filter((p) => side(p) === d0);
    const peak = inside.reduce((best, p) =>
      d0 === 'up' ? (p.value > best.value ? p : best) : p.value < best.value ? p : best,
    );
    const segMedian = robustStats(inside.map((p) => p.value)).median;
    const medZ = robustStats(inside.map((p) => Math.abs(devOf(p)) / scale)).median;
    const score = round3(
      0.5 * Math.min(1, inside.length / (4 * persistence)) + 0.5 * Math.min(1, medZ / z),
    );
    const onset = pts[onsetIdx] as SeriesPoint;
    const beforeRun = i > 0 ? (pts[i - 1] as SeriesPoint) : undefined;
    const endPoint = endIdx === null ? undefined : (pts[endIdx] as SeriesPoint);
    const evidence = new Set<string>([onset.evidenceId]);
    for (const p of pts.slice(i, i + persistence)) evidence.add(p.evidenceId);
    evidence.add(peak.evidenceId);
    if (endPoint !== undefined) evidence.add(endPoint.evidenceId);
    anomalies.push({
      service: series.service,
      metric: series.name,
      unit: series.unit,
      direction: d0,
      onsetUs: onset.ts,
      onsetResolutionUs: Math.max(1, onset.ts - (beforeRun?.ts ?? scanFrom)),
      changePointUs: (pts[changeIdx] as SeriesPoint).ts,
      firstExceedanceUs: (pts[i] as SeriesPoint).ts,
      endUs: endPoint?.ts ?? null,
      status: endPoint === undefined ? 'ongoing' : 'recovered',
      rule,
      samples: lastIn - i + 1,
      baseline: {
        window: opts.baseline,
        median: round3(stats.median),
        mad: round3(stats.mad),
        samples: base.length,
        strongThreshold: round3(strongT),
        moderateThreshold: round3(moderateT),
        medianEvidenceIds,
      },
      value: { median: round3(segMedian), peak: peak.value, peakUs: peak.ts },
      ratio: stats.median === 0 ? null : round3(segMedian / stats.median),
      delta: round3(segMedian - stats.median),
      confidence: { score, level: score >= 0.75 ? 'high' : score >= 0.5 ? 'medium' : 'low' },
      evidenceIds: [...evidence],
    });
    if (endIdx === null) break;
    i = endIdx;
    cusumFrom = endIdx;
  }
  return anomalies;
}

/**
 * One-sided CUSUM change point: S_t = max(0, S_{t-1} + d_t − k), d_t the standardized deviation
 * in the anomaly's direction. Returns the index after the last time S was 0 before the first
 * exceedance, i.e. where the accumulation that led to the alarm started.
 */
function cusumOnset(
  pts: readonly SeriesPoint[],
  from: number,
  firstExceed: number,
  med: number,
  scale: number,
  slack: number,
  d: Direction,
): number {
  let s = 0;
  let lastZero = from - 1;
  for (let t = from; t < firstExceed; t++) {
    const dev = ((pts[t] as SeriesPoint).value - med) / scale;
    s = Math.max(0, s + (d === 'up' ? dev : -dev) - slack);
    if (s === 0) lastZero = t;
  }
  return Math.min(firstExceed, Math.max(from, lastZero + 1));
}

/** Runs the detector over many series. */
export function scanAnomalies(all: readonly Series[], opts: AnomalyOptions): AnomalyScan {
  const anomalies: Anomaly[] = [];
  const skipped: SkippedSeries[] = [];
  for (const s of all) {
    const r = detectAnomalies(s, opts);
    if (Array.isArray(r)) anomalies.push(...r);
    else skipped.push(r);
  }
  anomalies.sort(
    (a, b) =>
      a.onsetUs - b.onsetUs ||
      (a.service < b.service ? -1 : a.service > b.service ? 1 : 0) ||
      (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0),
  );
  return { anomalies, skipped };
}
