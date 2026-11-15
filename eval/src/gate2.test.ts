// Gate 2 (brief §11): on scenario A the deterministic analyzers, WITHOUT any LLM, find the
// root-cause signals: pool saturation precedes the latency rise, pool-acquire wait dominates
// latency attribution, DB execution time is flat. Plus the Phase 2 requirements: neutral IDs,
// persistence, tick-level ties reported as inconclusive, success/failure attribution split,
// hold-and-wait detection, and the red herrings not blamed.
//
// The simulator only produces the telemetry. Everything asserted below is computed by
// analyzeIncident(), which reads through the store alone; the ground-truth file is the answer key.

import { readFileSync } from 'node:fs';
import { comparePrecedence, onsetFromAnomaly, type Anomaly } from '@tracepilot/analysis';
import { recordPoolExhaustion, runSimulation } from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { analyzeIncident, type IncidentAnalysis } from './pipeline.ts';

const GroundTruth = z.object({
  rootCause: z.object({
    changeEventId: z.string(),
    service: z.string(),
    resource: z.string(),
    symptomService: z.string(),
  }),
  causalChain: z.array(z.object({ atUs: z.number().optional() })),
  affectedServices: z.array(z.string()),
  redHerrings: z.array(
    z.object({
      kind: z.enum(['change', 'disturbance']),
      changeEventId: z.string().optional(),
      service: z.string().optional(),
      fromUs: z.number().optional(),
      toUs: z.number().optional(),
    }),
  ),
});
const truth = GroundTruth.parse(
  JSON.parse(
    readFileSync(new URL('../ground-truth/pool-exhaustion.json', import.meta.url), 'utf8'),
  ),
);
const DEPLOY_US = truth.causalChain[0]?.atUs ?? NaN;
const changeHerring = truth.redHerrings.find((h) => h.kind === 'change')?.changeEventId ?? '';
const blip = truth.redHerrings.find((h) => h.kind === 'disturbance');
const BLIP_SERVICE = blip?.service ?? '';
const BLIP_END_US = blip?.toUs ?? NaN;

/** Largest pre-deploy pool_in_use sample, read straight from the store (for the persistence check). */
const preDeployPoolMax = new Map<number, { value: number; capacity: number }>();

function analyzeSeed(seed: number): IncidentAnalysis {
  const rec = recordPoolExhaustion(seed);
  const { telemetry } = runSimulation(rec.config, rec.workload);
  const store = new TelemetryStore(':memory:');
  try {
    const { incident } = store.ingest(telemetry);
    const pre = store.getMetricSeries(incident.id, {
      service: 'db',
      name: 'pool_in_use',
      toUs: DEPLOY_US,
    });
    const cap = store.getMetricSeries(incident.id, {
      service: 'db',
      name: 'pool_capacity',
      toUs: DEPLOY_US,
    });
    preDeployPoolMax.set(seed, {
      value: Math.max(...pre.map((p) => p.value)),
      capacity: cap[0]?.value ?? NaN,
    });
    return analyzeIncident(store, incident.id);
  } finally {
    store.close();
  }
}

const sustained = (a: IncidentAnalysis, service: string, metric: string): Anomaly | undefined =>
  a.anomalies.anomalies.find(
    (x) => x.service === service && x.metric === metric && x.status === 'ongoing',
  );

describe.each([42, 3, 7])('Gate 2 on scenario A, seed %i', (seed) => {
  let a: IncidentAnalysis;
  beforeAll(() => {
    a = analyzeSeed(seed);
  });

  // ---- Windows and IDs ----------------------------------------------------------------------

  it('works under a neutral incident ID and finds the symptom at the entry service', () => {
    expect(a.incident.id).toMatch(/^in_[0-9a-z]+$/);
    expect(a.graph.entryServices).toEqual([truth.rootCause.symptomService]);
    expect(a.windows.symptom.service).toBe(truth.rootCause.symptomService);
    expect(a.windows.symptom.onsetUs).toBeGreaterThan(DEPLOY_US);
    expect(a.windows.symptom.onsetUs - DEPLOY_US).toBeLessThanOrEqual(15_000_000);
    expect(a.windows.baseline.toUs).toBeLessThan(DEPLOY_US);
  });

  // ---- Gate 2.1: pool saturation precedes the latency rise ---------------------------------

  it('flags the pool as saturated during the incident and nothing as saturated before it', () => {
    const pool = a.saturation.find((r) => r.resource === `${truth.rootCause.resource}`);
    expect(pool).toMatchObject({ status: 'saturated', capacity: { source: 'metric' } });
    expect(pool?.saturatedShare).toBeGreaterThan(0.95);
    expect(pool?.saturatedFromUs).toBeGreaterThan(DEPLOY_US);
    expect(
      a.saturationInBaseline.filter((r) => r.status === 'saturated' || r.status === 'busy'),
    ).toEqual([]);
    // The DB executor is NOT the bottleneck: it never queues.
    expect(a.saturation.find((r) => r.resource === 'db.executor')?.saturation.max).toBe(0);
  });

  it('pool saturation precedes the checkout latency/error rise: inconclusive per metric tick, ordered by spans', () => {
    // Metric level: both onsets fall within one tick of each other, so no order is claimed.
    const pool = sustained(a, 'db', 'pool_in_use') ?? sustained(a, 'db', 'pool_wait_queue');
    const latency = sustained(a, 'checkout', 'latency_p99');
    if (pool === undefined || latency === undefined) throw new Error('missing metric anomalies');
    expect(comparePrecedence(onsetFromAnomaly(pool), onsetFromAnomaly(latency)).verdict).toBe(
      'inconclusive',
    );
    // Span level: the pool was observed full (persistently) before checkout requests turned slow or failed.
    const full = a.refined.onsets['db'];
    const symptom = a.refined.byOperation['checkout/place-order'];
    if (full === undefined || symptom === undefined) throw new Error('missing span onsets');
    const p = comparePrecedence(full, symptom);
    expect(p.verdict).toBe('a_before_b');
    expect(p.deltaUs).toBeGreaterThan(p.resolutionUs);
    expect(full.ts).toBeGreaterThan(DEPLOY_US);
    expect(full.evidenceIds.length).toBeGreaterThan(0);
  });

  it('propagation puts the origin at the database on every failure path, with no precedence violation', () => {
    expect(a.propagation.origins[0]?.service).toBe('db');
    expect(a.propagation.origins.map((o) => o.service)).toEqual(['db']);
    expect(a.propagation.paths.length).toBeGreaterThan(0);
    expect(a.propagation.paths.every((p) => p.consistent)).toBe(true);
    // Every hop into the db is ordered (span resolution), and consistent with propagation upward.
    const intoDb = a.propagation.edges.filter((e) => e.callee === 'db');
    expect(intoDb.length).toBeGreaterThanOrEqual(3);
    expect(intoDb.every((e) => e.consistent === true)).toBe(true);
    for (const s of truth.affectedServices)
      expect(a.propagation.onsets.map((o) => o.service)).toContain(s);
  });

  // ---- Gate 2.2: pool-acquire wait dominates latency attribution ----------------------------

  it('attributes incident latency mainly to pool-acquire wait, for successes and failures alike', () => {
    const groups = a.attribution.incident.groups;
    expect(groups.map((g) => g.outcome)).toEqual(['success', 'failure']);
    for (const g of groups) {
      expect(g.dominant, g.outcome).toBe('pool_acquire');
      expect(g.shares.pool_acquire, g.outcome).toBeGreaterThan(0.5);
      expect(g.shares.query_exec, g.outcome).toBeLessThan(0.01);
      expect(g.shares.db_queue, g.outcome).toBe(0);
      // Part of that wait happened while the request already held a connection.
      expect(g.heldConnection.byCategory.pool_acquire, g.outcome).toBeGreaterThan(0);
    }
    // The remaining time is queueing for a checkout worker, itself held up by the pool.
    expect(groups[1]?.shares.queue_wait).toBeGreaterThan(0.2);
  });

  it('attributes baseline latency to query execution, with no pool wait', () => {
    const [g] = a.attribution.baseline.groups;
    expect(g).toMatchObject({ outcome: 'success', dominant: 'query_exec' });
    expect(g?.shares.pool_acquire).toBeLessThan(0.01);
    expect(a.attribution.baseline.groups).toHaveLength(1); // no failures at all
  });

  // ---- Gate 2.3: DB execution time is flat ---------------------------------------------------

  it('finds DB execution time per statement flat (the fact that rules out "the DB is slow")', () => {
    expect(a.dbQueries.execFlat).toBe(true);
    expect(a.dbQueries.exec.some((c) => c.shift === 'up' || c.shift === 'down')).toBe(false);
    expect(a.dbQueries.exec.filter((c) => c.shift === 'flat').length).toBeGreaterThanOrEqual(4);
    expect(a.anomalies.anomalies.filter((x) => x.metric === 'query_exec_p95')).toEqual([]);
  });

  // ---- Hold-and-wait --------------------------------------------------------------------------

  it('detects hold-and-wait in the incident and not in the baseline', () => {
    const inc = a.holdAndWait.incident;
    expect(inc.detected).toBe(true);
    expect(inc.pool.medianUtilization).toBe(1);
    expect(inc.pool.medianIdleHeldFraction).toBeGreaterThan(0.8);
    expect(inc.transactions.nestedWaitShare).toBeGreaterThan(0.9);
    expect(inc.transactions.holders[0]?.service).toBe(truth.rootCause.service);
    expect(inc.transactions.waiters.map((w) => w.service).sort()).toEqual(['inventory', 'payment']);
    expect(a.holdAndWait.baseline.detected).toBe(false);
    expect(a.holdAndWait.baseline.transactions.nestedWaitShare).toBeLessThan(0.05);
  });

  // ---- Persistence ---------------------------------------------------------------------------

  it('flags nothing sustained before the deploy: momentary gauge spikes are not anomalies', () => {
    const early = a.anomalies.anomalies.filter((x) => x.onsetUs < DEPLOY_US);
    // Only the self-resolving blip, all recovered within a minute of it.
    expect(
      early.every(
        (x) => x.status === 'recovered' && (x.endUs ?? Infinity) < BLIP_END_US + 60_000_000,
      ),
    ).toBe(true);
    expect(early.filter((x) => x.metric.startsWith('pool_'))).toEqual([]);
    // Seed 42 has a momentary 30/30 pool sample during a random burst before the deploy: it is
    // in the telemetry, and it is not an anomaly.
    if (seed === 42) {
      const spike = preDeployPoolMax.get(seed);
      expect(spike?.value).toBe(spike?.capacity);
    }
    expect(sustained(a, 'db', 'pool_in_use')?.onsetUs).toBeGreaterThanOrEqual(DEPLOY_US);
  });

  // ---- Red herrings ----------------------------------------------------------------------------

  it('does not blame the inventory config change, and does correlate the deploy', () => {
    const herring = a.changeCorrelation.find((c) => c.changeId === changeHerring);
    const deploy = a.changeCorrelation.find((c) => c.changeId === truth.rootCause.changeEventId);
    expect(herring?.verdict).toBe('none');
    expect(herring?.reason).toMatch(
      new RegExp(`explained by an earlier-or-equal anomaly in ${BLIP_SERVICE}`),
    );
    expect(deploy?.verdict).toBe('correlated');
    expect(deploy?.sustained).toBe(true);
  });

  it('sees the payment blip as a recovered, excluded episode, not part of the incident', () => {
    const blipAnomalies = a.anomalies.anomalies.filter(
      (x) => x.service === BLIP_SERVICE && x.onsetUs < DEPLOY_US,
    );
    expect(blipAnomalies.length).toBeGreaterThan(0);
    expect(blipAnomalies.every((x) => x.status === 'recovered')).toBe(true);
    expect(a.propagation.excluded.some((e) => e.service === BLIP_SERVICE)).toBe(true);
    expect(a.propagation.origins.some((o) => o.service === BLIP_SERVICE)).toBe(false);
    const blipBursts = a.logBursts.filter(
      (b) => b.service === BLIP_SERVICE && b.startUs < DEPLOY_US,
    );
    expect(blipBursts.every((b) => b.endUs !== null && b.endUs < DEPLOY_US)).toBe(true);
  });

  // ---- Timeline ---------------------------------------------------------------------------------

  it('builds one ordered, evidence-cited timeline with the deploy before the incident onsets', () => {
    const t = a.timeline;
    expect(t.every((e, i) => i === 0 || (t[i - 1]?.ts ?? 0) <= e.ts)).toBe(true);
    expect(t.every((e) => e.evidenceIds.length > 0)).toBe(true);
    const deploy = t.findIndex(
      (e) => e.kind === 'change' && e.evidenceIds.includes(truth.rootCause.changeEventId),
    );
    const poolFull = t.findIndex((e) => e.kind === 'span_onset' && e.service === 'db');
    const firstIncidentAnomaly = t.findIndex(
      (e) => e.kind === 'anomaly_onset' && e.status === 'ongoing',
    );
    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeLessThan(poolFull);
    expect(poolFull).toBeLessThan(
      t.findIndex((e) => e.kind === 'span_onset' && e.service === 'checkout'),
    );
    expect(deploy).toBeLessThan(firstIncidentAnomaly);
  });
});

// ---- Negative controls -------------------------------------------------------------------------
// The same pipeline on telemetry where the answer is different. Without these, analyzers that
// always report "pool exhaustion" would pass the tests above.

function analyzeConfig(
  mutate: (c: ReturnType<typeof recordPoolExhaustion>['config']) => void,
): IncidentAnalysis {
  const rec = recordPoolExhaustion(42, { deploy: false });
  mutate(rec.config);
  const { telemetry } = runSimulation(rec.config, rec.workload);
  const store = new TelemetryStore(':memory:');
  try {
    return analyzeIncident(store, store.ingest(telemetry).incident.id);
  } finally {
    store.close();
  }
}

describe('negative control: no deploy (only the red herrings)', () => {
  let a: IncidentAnalysis;
  beforeAll(() => {
    a = analyzeConfig(() => undefined);
  });

  it('finds only a recovered episode and no saturation, hold-and-wait or correlated change', () => {
    expect(a.windows.symptom.status).toBe('recovered');
    expect(a.saturation.filter((r) => r.status === 'saturated')).toEqual([]);
    expect(a.holdAndWait.incident.detected).toBe(false);
    expect(a.changeCorrelation.map((c) => [c.changeId, c.verdict])).toEqual([
      [changeHerring, 'none'],
    ]);
    expect(a.anomalies.anomalies.filter((x) => x.status === 'ongoing')).toEqual([]);
  });
});

describe('negative control: the database itself gets slow', () => {
  const QUERY_STEPS: [string, string][] = [
    ['checkout', 'load-cart'],
    ['checkout', 'insert-order'],
    ['inventory', 'reserve-stock'],
    ['inventory', 'read-stock'],
    ['payment', 'insert-payment'],
    ['payment', 'update-payment'],
  ];
  let a: IncidentAnalysis;
  beforeAll(() => {
    a = analyzeConfig((c) => {
      c.disturbances = QUERY_STEPS.map(([service, step]) => ({
        description: 'db degraded',
        startUs: DEPLOY_US,
        endUs: c.durationUs,
        service,
        step,
        factor: 2,
      }));
    });
  });

  it('reports execution time UP, not flat', () => {
    expect(a.dbQueries.execFlat).toBe(false);
    const big = a.dbQueries.exec.filter((c) => c.window.count >= 100);
    expect(big.length).toBeGreaterThan(0);
    expect(big.every((c) => c.shift === 'up')).toBe(true);
    expect(sustained(a, 'db', 'query_exec_p95')?.direction).toBe('up');
  });

  it('attributes latency to query execution, with no hold-and-wait', () => {
    for (const g of a.attribution.incident.groups) {
      expect(g.dominant, g.outcome).toBe('query_exec');
      expect(g.shares.query_exec, g.outcome).toBeGreaterThan(3 * g.shares.pool_acquire);
    }
    expect(a.holdAndWait.incident.detected).toBe(false);
    expect(a.holdAndWait.incident.transactions.nestedWaitShare).toBeLessThan(0.5);
  });

  it('reports the pool pressure a slow DB causes as short episodes, not exhaustion', () => {
    // Slower queries hold connections longer, so the pool does hit its limit at times: that is
    // true and is reported. Unlike the incident, it is not full for most of the window.
    const pool = a.saturation.find((r) => r.resource === 'db.pool');
    expect(pool?.saturatedShare).toBeLessThan(0.5);
    expect(pool?.utilization?.mean).toBeLessThan(0.95);
  });
});
