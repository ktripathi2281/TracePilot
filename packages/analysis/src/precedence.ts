// Onset estimates and temporal precedence (brief §4.6).
//
// An onset is never a point in time but an interval: a metric anomaly whose first anomalous
// sample is at ts happened somewhere in (ts − tick, ts]. Two onsets closer than the coarser of
// their resolutions cannot be ordered: the verdict is `inconclusive`, never a guess. In
// particular two metric onsets within ONE metric tick are a tie.
//
// Onsets can be refined from spans, whose timestamps are exact. A span-level onset's resolution
// is the local spacing of the sampled spans it was found in (unsampled requests could have
// crossed the threshold anywhere in that gap).

import type { Span } from '@tracepilot/schema';
import type { Anomaly } from './anomaly.ts';
import { spanEvidence } from './traces.ts';

export interface OnsetEstimate {
  /** Human-readable signal name, e.g. `db pool_in_use up` or `checkout server latency`. */
  label: string;
  service: string;
  /** Latest time by which the change had happened. */
  ts: number;
  /** The change happened in (ts − resolutionUs, ts]. */
  resolutionUs: number;
  basis: 'metric' | 'span';
  evidenceIds: string[];
}

export type PrecedenceVerdict = 'a_before_b' | 'b_before_a' | 'inconclusive';

export interface Precedence {
  a: string;
  b: string;
  verdict: PrecedenceVerdict;
  /** b.ts − a.ts. */
  deltaUs: number;
  /** The coarser of the two resolutions; |delta| must exceed it for a verdict. */
  resolutionUs: number;
  basis: 'metric' | 'span' | 'mixed';
  reason: string;
}

export function onsetFromAnomaly(a: Anomaly): OnsetEstimate {
  return {
    label: `${a.service} ${a.metric} ${a.direction}`,
    service: a.service,
    ts: a.onsetUs,
    resolutionUs: a.onsetResolutionUs,
    basis: 'metric',
    evidenceIds: a.evidenceIds.slice(0, 2),
  };
}

export function comparePrecedence(a: OnsetEstimate, b: OnsetEstimate): Precedence {
  const deltaUs = b.ts - a.ts;
  const resolutionUs = Math.max(a.resolutionUs, b.resolutionUs);
  const basis = a.basis === b.basis ? a.basis : 'mixed';
  const ms = (us: number): string => `${(us / 1000).toFixed(1)} ms`;
  if (Math.abs(deltaUs) <= resolutionUs) {
    return {
      a: a.label,
      b: b.label,
      verdict: 'inconclusive',
      deltaUs,
      resolutionUs,
      basis,
      reason: `onsets ${ms(Math.abs(deltaUs))} apart, within the ${ms(resolutionUs)} resolution`,
    };
  }
  return {
    a: a.label,
    b: b.label,
    verdict: deltaUs > 0 ? 'a_before_b' : 'b_before_a',
    deltaUs,
    resolutionUs,
    basis,
    reason: `${deltaUs > 0 ? a.label : b.label} leads by ${ms(Math.abs(deltaUs))} (resolution ${ms(resolutionUs)})`,
  };
}

export interface SpanOnsetOptions {
  label: string;
  service: string;
  /** Spans that could show the signal (exceeding or not), any order. */
  candidates: readonly Span[];
  /** When the span became anomalous, or null if it never did. */
  exceedAt: (s: Span) => number | null;
  /** Ignore candidates starting before this. */
  fromUs: number;
  /**
   * Persistence at span level. The onset is the first exceeding candidate c such that, over the
   * candidates starting in [c.start, c.start + max(windowUs, time spanned by the next
   * `lookahead` candidates)], at least `minExceeding` exceed and they are at least
   * `minFraction` of all of them. The duration part rejects momentary bursts in dense spans;
   * the count part lets sparse span types qualify. Defaults: 3, 5, 0.5.
   */
  windowUs: number;
  minExceeding?: number;
  lookahead?: number;
  minFraction?: number;
}

/** Earliest persistent exceedance among sampled spans; null if the signal never persists. */
export function spanOnset(opts: SpanOnsetOptions): OnsetEstimate | null {
  const minExceeding = opts.minExceeding ?? 3;
  const lookahead = Math.max(minExceeding, opts.lookahead ?? 5);
  const minFraction = opts.minFraction ?? 0.5;
  const cands = opts.candidates
    .filter((s) => s.startUs >= opts.fromUs)
    .map((s) => ({ s, at: opts.exceedAt(s) }))
    .sort((x, y) => x.s.startUs - y.s.startUs || (x.s.spanId < y.s.spanId ? -1 : 1));
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i] as (typeof cands)[number];
    if (c.at === null) continue;
    const last = cands[Math.min(cands.length, i + lookahead) - 1] as (typeof cands)[number];
    const until = Math.max(c.s.startUs + opts.windowUs, last.s.startUs + 1);
    let total = 0;
    const exceeding: Span[] = [];
    for (let j = i; j < cands.length; j++) {
      const d = cands[j] as (typeof cands)[number];
      if (d.s.startUs >= until) break;
      total++;
      if (d.at !== null) exceeding.push(d.s);
    }
    if (exceeding.length < minExceeding || exceeding.length / total < minFraction) continue;
    // Resolution: the gap to the previous sampled candidate. An unsampled request could have
    // crossed the threshold anywhere in it.
    const prevStart = i > 0 ? (cands[i - 1] as (typeof cands)[number]).s.startUs : opts.fromUs;
    return {
      label: opts.label,
      service: opts.service,
      ts: c.at,
      resolutionUs: Math.max(1, c.s.startUs - prevStart),
      basis: 'span',
      evidenceIds: exceeding.slice(0, 3).map(spanEvidence),
    };
  }
  return null;
}
