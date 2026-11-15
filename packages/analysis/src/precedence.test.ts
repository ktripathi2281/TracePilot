import type { DependencyGraph } from '@tracepilot/schema';
import { describe, expect, it } from 'vitest';
import type { Anomaly } from './anomaly.ts';
import { refineOnsetsFromSpans } from './onsets.ts';
import { comparePrecedence, spanOnset, type OnsetEstimate } from './precedence.ts';
import { analyzePropagation } from './propagation.ts';
import { MS, S, TICK, TraceBuilder } from './testkit.ts';

const onset = (
  label: string,
  ts: number,
  resolutionUs: number,
  basis: 'metric' | 'span' = 'metric',
): OnsetEstimate => ({
  label,
  service: label,
  ts,
  resolutionUs,
  basis,
  evidenceIds: [],
});

describe('comparePrecedence', () => {
  it('is inconclusive for metric onsets within one tick, including exactly one tick apart', () => {
    expect(comparePrecedence(onset('a', 600 * S, TICK), onset('b', 600 * S, TICK)).verdict).toBe(
      'inconclusive',
    );
    expect(comparePrecedence(onset('a', 600 * S, TICK), onset('b', 605 * S, TICK)).verdict).toBe(
      'inconclusive',
    );
    expect(comparePrecedence(onset('a', 600 * S, TICK), onset('b', 610 * S, TICK)).verdict).toBe(
      'a_before_b',
    );
    expect(comparePrecedence(onset('a', 610 * S, TICK), onset('b', 600 * S, TICK)).verdict).toBe(
      'b_before_a',
    );
  });

  it('uses the coarser resolution when mixing span and metric onsets', () => {
    const p = comparePrecedence(onset('a', 600 * S, 20 * MS, 'span'), onset('b', 603 * S, TICK));
    expect(p).toMatchObject({ verdict: 'inconclusive', resolutionUs: TICK, basis: 'mixed' });
    expect(
      comparePrecedence(
        onset('a', 600 * S, 20 * MS, 'span'),
        onset('b', 600 * S + 100 * MS, 30 * MS, 'span'),
      ).verdict,
    ).toBe('a_before_b');
  });
});

/** One single-span trace per start time; `bad` decides which ones exceed. */
function spansAt(starts: number[], bad: (i: number) => boolean, service = 'svc') {
  return starts.map((t, i) => {
    const b = new TraceBuilder();
    b.span(service, 'op', t, t + (bad(i) ? 900 * MS : 10 * MS), { status: 'ok' });
    return b.spans[0] as NonNullable<(typeof b.spans)[0]>;
  });
}

describe('spanOnset', () => {
  const exceedAt = (s: { startUs: number; endUs: number }) =>
    s.endUs - s.startUs > 500 * MS ? s.startUs + 500 * MS : null;

  it('finds the first persistent exceedance with the sampling gap as resolution', () => {
    const starts = Array.from({ length: 200 }, (_, i) => i * 100 * MS);
    const spans = spansAt(starts, (i) => i >= 120);
    const o = spanOnset({
      label: 'x',
      service: 'svc',
      candidates: spans,
      exceedAt,
      fromUs: 0,
      windowUs: TICK,
    });
    expect(o).toMatchObject({
      ts: 120 * 100 * MS + 500 * MS,
      resolutionUs: 100 * MS,
      basis: 'span',
    });
  });

  it('rejects a momentary burst in dense spans (persistence in time, not just count)', () => {
    const starts = Array.from({ length: 400 }, (_, i) => i * 50 * MS);
    const spans = spansAt(starts, (i) => (i >= 100 && i < 106) || i >= 300);
    const o = spanOnset({
      label: 'x',
      service: 'svc',
      candidates: spans,
      exceedAt,
      fromUs: 0,
      windowUs: TICK,
    });
    expect(o?.ts).toBe(300 * 50 * MS + 500 * MS);
  });

  it('accepts a persistent signal in sparse spans (count-based window)', () => {
    const starts = Array.from({ length: 20 }, (_, i) => i * 8 * S);
    const spans = spansAt(starts, (i) => i >= 10);
    const o = spanOnset({
      label: 'x',
      service: 'svc',
      candidates: spans,
      exceedAt,
      fromUs: 0,
      windowUs: TICK,
    });
    expect(o).toMatchObject({ ts: 80 * S + 500 * MS, resolutionUs: 8 * S });
  });

  it('returns null when the signal never persists (negative case)', () => {
    const starts = Array.from({ length: 200 }, (_, i) => i * 100 * MS);
    const spans = spansAt(starts, (i) => i % 10 === 0);
    expect(
      spanOnset({
        label: 'x',
        service: 'svc',
        candidates: spans,
        exceedAt,
        fromUs: 0,
        windowUs: TICK,
      }),
    ).toBeNull();
  });
});

describe('refineOnsetsFromSpans', () => {
  it('derives per-operation thresholds from the baseline and finds slow-or-failing onsets and a full pool', () => {
    const spans = [];
    for (let i = 0; i < 400; i++) {
      const t = i * 100 * MS;
      const b = new TraceBuilder();
      const late = t >= 30 * S;
      // After 30 s half the requests fail fast and half are slow: neither alone is a majority.
      const root = b.span(
        'svc',
        'op',
        t,
        t + (late && i % 2 === 0 ? 2 * MS : late ? 800 * MS : 20 * MS),
        {
          status: late && i % 2 === 0 ? 'error' : 'ok',
        },
      );
      b.span('svc', 'db.pool.acquire', t + MS, t + MS, {
        parent: root,
        attrs: { 'db.pool.capacity': 10, 'db.pool.in_use': t >= 29 * S ? 10 : 4 },
      });
      spans.push(...b.spans);
    }
    const r = refineOnsetsFromSpans(spans, {
      baseline: { fromUs: 0, toUs: 20 * S },
      fromUs: 20 * S,
      windowUs: TICK,
    });
    expect(r.thresholdsUs['svc/op']).toBe(40 * MS); // max(2 × p99 20 ms, 20 ms + 10 ms floor)
    expect(r.onsets['svc']?.ts).toBe(30 * S + 2 * MS); // the first fast failure
    expect(r.byOperation['svc/op']?.ts).toBe(30 * S + 2 * MS);
    expect(r.onsets['db']?.ts).toBe(29 * S + MS);
  });
});

describe('propagation', () => {
  const edge = (from: string, to: string, ops = ['op']) => ({
    from,
    to,
    kind: 'call' as const,
    callerOperations: ops,
    callCount: 10,
    errorCount: 0,
    latencyP50Us: 1,
    latencyP95Us: 2,
    evidenceIds: ['sp_0000000000000001'],
  });
  const node = (service: string) => ({
    service,
    kind: 'service' as const,
    spanCount: 1,
    errorCount: 0,
  });
  const graph: DependencyGraph = {
    nodes: ['a', 'b', 'c', 'side'].map(node),
    edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'side', ['other'])],
    entryServices: ['a'],
  };
  const anomaly = (service: string, onsetUs: number, over: Partial<Anomaly> = {}): Anomaly =>
    ({
      service,
      metric: 'latency_p99',
      unit: 'us',
      direction: 'up',
      onsetUs,
      onsetResolutionUs: TICK,
      changePointUs: onsetUs,
      firstExceedanceUs: onsetUs,
      endUs: null,
      status: 'ongoing',
      rule: 'strong-run',
      samples: 10,
      baseline: {
        window: { fromUs: 0, toUs: 1 },
        median: 1,
        mad: 0,
        samples: 10,
        strongThreshold: 1,
        moderateThreshold: 1,
        medianEvidenceIds: [],
      },
      value: { median: 2, peak: 3, peakUs: onsetUs },
      ratio: 2,
      delta: 1,
      confidence: { score: 1, level: 'high' },
      evidenceIds: [`mt_${service}_latency_p99_${String(onsetUs)}`],
      ...over,
    }) as Anomaly;
  const incident = { fromUs: 600 * S, toUs: 900 * S };

  it('walks the failure path to its origin with consistent precedence', () => {
    const r = analyzePropagation(
      graph,
      [anomaly('c', 600 * S), anomaly('b', 620 * S), anomaly('a', 640 * S)],
      { incident },
    );
    expect(r.paths.map((p) => [p.nodes.join('>'), p.consistent, p.orderedHops])).toEqual([
      ['a>b>c', true, 2],
    ]);
    expect(r.origins.map((o) => o.service)).toEqual(['c']);
  });

  it('reports a violation when the caller is anomalous before its callee', () => {
    const r = analyzePropagation(
      graph,
      [anomaly('c', 700 * S), anomaly('b', 620 * S), anomaly('a', 640 * S)],
      { incident },
    );
    expect(r.edges.find((e) => e.callee === 'c')?.consistent).toBe(false);
    expect(r.paths[0]?.consistent).toBe(false);
  });

  it('keeps metric onsets within one tick inconclusive, and lets span refinements order them', () => {
    const anomalies = [anomaly('c', 600 * S), anomaly('b', 600 * S), anomaly('a', 605 * S)];
    const coarse = analyzePropagation(graph, anomalies, { incident });
    expect(coarse.edges.map((e) => e.precedence.verdict)).toEqual(['inconclusive', 'inconclusive']);
    expect(coarse.paths[0]?.orderedHops).toBe(0);
    const fine = analyzePropagation(graph, anomalies, {
      incident,
      refinedOnsets: {
        c: onset('c', 596 * S, 10 * MS, 'span'),
        b: onset('b', 598 * S, 10 * MS, 'span'),
      },
    });
    expect(fine.edges.find((e) => e.callee === 'c')?.precedence.verdict).toBe('a_before_b');
  });

  it('rejects a span refinement later than the metric onset allows', () => {
    const r = analyzePropagation(graph, [anomaly('c', 600 * S)], {
      incident,
      refinedOnsets: { c: onset('c', 650 * S, 10 * MS, 'span') },
    });
    expect(r.onsets[0]).toMatchObject({ refinement: 'rejected-later-than-metric' });
    expect(r.onsets[0]?.onset.ts).toBe(600 * S);
  });

  it('uses the caller onset of the operations that make the call', () => {
    // `a` failed first on its `other` route (calls `side`), later on `op` (calls `b`).
    const anomalies = [anomaly('b', 610 * S), anomaly('a', 610 * S), anomaly('side', 600 * S)];
    const r = analyzePropagation(graph, anomalies, {
      incident,
      refinedOnsets: {
        a: onset('a', 601 * S, 10 * MS, 'span'),
        b: onset('b', 605 * S, 10 * MS, 'span'),
      },
      refinedByOperation: {
        'a/other': onset('a/other', 601 * S, 10 * MS, 'span'),
        'a/op': onset('a/op', 607 * S, 10 * MS, 'span'),
      },
    });
    expect(r.edges.find((e) => e.callee === 'b')?.consistent).toBe(true);
  });

  it('excludes anomalies that recovered before the incident (a self-resolving blip)', () => {
    const blip = anomaly('side', 420 * S, { status: 'recovered', endUs: 445 * S });
    const r = analyzePropagation(
      graph,
      [blip, anomaly('c', 600 * S), anomaly('b', 620 * S), anomaly('a', 640 * S)],
      { incident },
    );
    expect(r.excluded.map((e) => e.service)).toEqual(['side']);
    expect(r.origins.map((o) => o.service)).toEqual(['c']);
  });

  it('finds no path when nothing is anomalous (negative case)', () => {
    expect(analyzePropagation(graph, [], { incident })).toMatchObject({
      paths: [],
      origins: [],
      onsets: [],
    });
  });
});
