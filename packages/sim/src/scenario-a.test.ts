// Scenario A (`pool-exhaustion`) must produce the incident described in brief §5 from the model
// itself. These assertions are the calibration targets; `pnpm run calibrate` prints the numbers.
import {
  SPAN_ATTRS,
  SPAN_NAMES,
  US_PER_MIN,
  US_PER_MS,
  US_PER_S,
  type Patch,
  type Span,
} from '@tracepilot/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { runSimulation, type SimResult } from './engine.ts';
import { hashTelemetry } from './hash.ts';
import { applyPatches } from './knobs.ts';
import type { Recording } from './model.ts';
import {
  POOL_EXHAUSTION_CHANGE_IDS as IDS,
  POOL_EXHAUSTION_TIMES as T,
  recordPoolExhaustion,
} from './scenarios/pool-exhaustion.ts';
import { recordScenario } from './scenarios/index.ts';
import {
  findTelemetryProblems,
  metricMax,
  metricMean,
  metricSeries,
  summarizeOutcomes,
} from './summary.ts';
import { percentile } from './util.ts';

const BASE_FROM = 1 * US_PER_MIN;
const BASE_TO = 6 * US_PER_MIN;
const INC_FROM = 11 * US_PER_MIN;
const INC_TO = T.durationUs;
const POOL = 30;

let rec: Recording;
let run: SimResult;
const replay = (patches: Patch[]): SimResult =>
  runSimulation(applyPatches(rec.config, patches), rec.workload);

beforeAll(() => {
  rec = recordScenario('pool-exhaustion', 42);
  run = runSimulation(rec.config, rec.workload);
});

const spansIn = (r: SimResult, name: string, from: number, to: number): Span[] =>
  r.telemetry.spans.filter((s) => s.name === name && s.endUs >= from && s.endUs < to);
const durations = (spans: Span[]): number[] => spans.map((s) => s.endUs - s.startUs);
const baselineOf = (r: SimResult) => summarizeOutcomes(r.outcomes, 'checkout', BASE_FROM, BASE_TO);
const incidentOf = (r: SimResult) => summarizeOutcomes(r.outcomes, 'checkout', INC_FROM, INC_TO);

describe('telemetry', () => {
  it('passes the same schema validation an ingestor would apply', () => {
    expect(findTelemetryProblems(run.telemetry)).toEqual([]);
    expect(run.telemetry.spans.length).toBeGreaterThan(20_000);
    expect(run.stats.tracesTruncated).toBeLessThan(30);
  });

  it('emits every required metric for every service every 5 s', () => {
    const ticks = T.durationUs / (5 * US_PER_S);
    for (const service of ['api-gateway', 'checkout', 'inventory', 'payment']) {
      for (const name of ['request_rate', 'in_flight', 'queue_depth'] as const) {
        expect(
          metricSeries(run.telemetry.metrics, service, name),
          `${service}/${name}`,
        ).toHaveLength(ticks);
      }
      for (const name of ['error_rate', 'latency_p50', 'latency_p95', 'latency_p99'] as const) {
        expect(
          metricSeries(run.telemetry.metrics, service, name).length,
          `${service}/${name}`,
        ).toBeGreaterThan(ticks - 3);
      }
    }
    for (const name of [
      'pool_in_use',
      'pool_capacity',
      'pool_wait_queue',
      'db_active_queries',
    ] as const) {
      expect(metricSeries(run.telemetry.metrics, 'db', name), name).toHaveLength(ticks);
    }
    expect(metricSeries(run.telemetry.metrics, 'db', 'query_exec_p95').length).toBeGreaterThan(
      ticks - 3,
    );
  });

  it('includes irrelevant noise logs', () => {
    const noise = run.telemetry.logs.filter(
      (l) => l.message === 'health check ok' || l.message === 'checkpoint complete',
    );
    expect(noise.length).toBeGreaterThan(20);
  });
});

describe('baseline (T+1 min to T+6 min)', () => {
  it('~80 checkout req/s, error rate ~0, p99 100–150 ms', () => {
    const b = baselineOf(run);
    expect(b.ratePerS).toBeGreaterThan(76);
    expect(b.ratePerS).toBeLessThan(84);
    expect(b.errorRate).toBe(0);
    expect(b.p99Us).toBeGreaterThan(100 * US_PER_MS);
    expect(b.p99Us).toBeLessThan(150 * US_PER_MS);
  });

  it('pool utilization 35–45 %, nobody waits for a connection', () => {
    const utilization =
      metricMean(run.telemetry.metrics, 'db', 'pool_in_use', BASE_FROM, BASE_TO) / POOL;
    expect(utilization).toBeGreaterThan(0.35);
    expect(utilization).toBeLessThan(0.45);
    expect(
      metricMax(run.telemetry.metrics, 'db', 'pool_wait_queue', BASE_FROM, BASE_TO),
    ).toBeLessThanOrEqual(2);
    const waits = durations(spansIn(run, SPAN_NAMES.poolAcquire, BASE_FROM, BASE_TO));
    expect(waits.length).toBeGreaterThan(5_000);
    expect(percentile(waits, 0.99)).toBeLessThan(10 * US_PER_MS);
  });
});

describe('red herrings', () => {
  it('1: an inventory config change 3.5 min before the deploy that changes nothing', () => {
    const ev = run.telemetry.changeEvents.find((c) => c.id === IDS.inventoryTweak);
    expect(ev).toMatchObject({ ts: T.inventoryTweakUs, kind: 'config', service: 'inventory' });
    expect(T.deployUs - T.inventoryTweakUs).toBe(3.5 * US_PER_MIN);
    // Proof that it is inert: remove it and every request, span and metric is identical.
    const without = replay([{ revert: IDS.inventoryTweak }]);
    expect(without.telemetry.changeEvents.map((c) => c.id)).toEqual([IDS.checkoutDeploy]);
    expect(without.outcomes).toEqual(run.outcomes);
    expect(without.telemetry.spans).toEqual(run.telemetry.spans);
    expect(without.telemetry.metrics).toEqual(run.telemetry.metrics);
  });

  it('2: a short payment latency blip 3 min before the deploy that resolves by itself', () => {
    const m = run.telemetry.metrics;
    const p95 = (from: number, to: number): number =>
      metricMean(m, 'payment', 'latency_p95', from, to);
    const before = p95(BASE_FROM, BASE_TO);
    const during = p95(T.paymentBlipStartUs + 5 * US_PER_S, T.paymentBlipEndUs);
    const after = p95(8 * US_PER_MIN, T.deployUs);
    expect(T.deployUs - T.paymentBlipStartUs).toBe(3 * US_PER_MIN);
    expect(during).toBeGreaterThan(2.5 * before);
    expect(Math.abs(after - before) / before).toBeLessThan(0.1);
    // It is visible downstream (checkout slows, more connections are held)...
    const blip = summarizeOutcomes(
      run.outcomes,
      'checkout',
      T.paymentBlipStartUs,
      T.paymentBlipEndUs,
    );
    expect(blip.p99Us).toBeGreaterThan(1.5 * baselineOf(run).p99Us);
    expect(
      metricMean(m, 'db', 'pool_in_use', T.paymentBlipStartUs, T.paymentBlipEndUs),
    ).toBeGreaterThan(1.2 * metricMean(m, 'db', 'pool_in_use', BASE_FROM, BASE_TO));
    // ...but it breaks nothing and is over well before the incident.
    expect(blip.errorRate).toBe(0);
    // The pool is never saturated for long before the deploy. (Gauges are point samples, so a
    // random burst can show one momentary 30/30 sample; it never lasts two samples in a row and
    // no acquire waits anywhere near 100 ms.)
    const early = metricSeries(m, 'db', 'pool_in_use', 0, T.deployUs).map(
      (p) => p.value >= 0.95 * POOL,
    );
    expect(early.filter(Boolean).length).toBeLessThanOrEqual(2);
    expect(early.some((full, i) => full && early[i - 1] === true)).toBe(false);
    const earlyWaits = durations(spansIn(run, SPAN_NAMES.poolAcquire, 0, T.deployUs));
    expect(Math.max(...earlyWaits)).toBeLessThan(100 * US_PER_MS);
    const calm = summarizeOutcomes(run.outcomes, 'checkout', 8 * US_PER_MIN, T.deployUs);
    expect(calm.errorRate).toBe(0);
    expect(calm.p99Us).toBeLessThan(150 * US_PER_MS);
    const slowLogs = run.telemetry.logs.filter(
      (l) => l.message === 'payment-provider slow response',
    );
    const inBlip = slowLogs.filter(
      (l) => l.ts >= T.paymentBlipStartUs && l.ts < T.paymentBlipEndUs + US_PER_S,
    );
    expect(inBlip.length).toBeGreaterThan(20);
    expect(inBlip.length / slowLogs.length).toBeGreaterThan(0.8);
  });
});

describe('incident', () => {
  it('starts with the checkout v2.4.1 deploy at T+10 min', () => {
    const ev = run.telemetry.changeEvents.find((c) => c.id === IDS.checkoutDeploy);
    expect(ev).toMatchObject({
      ts: 10 * US_PER_MIN,
      kind: 'deploy',
      service: 'checkout',
      diff: { workers: { from: 20, to: 60 }, 'params.reserveFanout': { from: 1, to: 4 } },
    });
    expect(metricMean(run.telemetry.metrics, 'db', 'pool_capacity', 0, T.durationUs)).toBe(POOL);
  });

  it('pool hits 100 % and the wait queue grows', () => {
    const m = run.telemetry.metrics;
    const saturated = metricSeries(m, 'db', 'pool_in_use', T.deployUs).find((p) => p.value >= POOL);
    expect(saturated?.ts).toBeLessThanOrEqual(T.deployUs + 30 * US_PER_S);
    expect(metricMean(m, 'db', 'pool_in_use', INC_FROM, INC_TO)).toBeGreaterThan(0.98 * POOL);
    expect(metricMean(m, 'db', 'pool_wait_queue', INC_FROM, INC_TO)).toBeGreaterThan(100);
    expect(metricMax(m, 'db', 'pool_wait_queue', 0, T.deployUs)).toBeLessThanOrEqual(3);
  });

  it('db.pool.acquire spans balloon from ~0 to seconds', () => {
    const waits = durations(spansIn(run, SPAN_NAMES.poolAcquire, INC_FROM, INC_TO));
    expect(waits.length).toBeGreaterThan(500);
    expect(percentile(waits, 0.5)).toBeGreaterThan(1 * US_PER_S);
    const full = spansIn(run, SPAN_NAMES.poolAcquire, INC_FROM, INC_TO).filter(
      (s) => s.attributes[SPAN_ATTRS.poolInUseAtAcquire] === s.attributes[SPAN_ATTRS.poolCapacity],
    );
    expect(full.length / waits.length).toBeGreaterThan(0.95);
  });

  it('checkout p99 reaches multiple seconds and requests hit the 5 s acquire timeout', () => {
    expect(incidentOf(run).p99Us).toBeGreaterThan(5 * US_PER_S);
    expect(
      metricMax(run.telemetry.metrics, 'checkout', 'latency_p99', INC_FROM, INC_TO),
    ).toBeGreaterThan(5 * US_PER_S);
    expect(run.stats.pool.acquireTimeouts).toBeGreaterThan(500);
    const timeoutLogs = run.telemetry.logs.filter(
      (l) => l.message === 'timeout acquiring connection after 5000ms',
    );
    expect(timeoutLogs.length).toBeGreaterThan(20);
    expect(timeoutLogs.every((l) => l.ts > T.deployUs && l.level === 'error')).toBe(true);
    const timedOut = spansIn(run, SPAN_NAMES.poolAcquire, INC_FROM, INC_TO).filter(
      (s) => s.status === 'timeout',
    );
    expect(timedOut.length).toBeGreaterThan(20);
    expect(timedOut.every((s) => s.endUs - s.startUs === 5 * US_PER_S)).toBe(true);
  });

  it('error rate climbs and the gateway shows 5xx', () => {
    expect(incidentOf(run).errorRate).toBeGreaterThan(0.5);
    const m = run.telemetry.metrics;
    expect(metricMean(m, 'api-gateway', 'error_rate', INC_FROM, INC_TO)).toBeGreaterThan(0.3);
    expect(metricMean(m, 'checkout', 'error_rate', INC_FROM, INC_TO)).toBeGreaterThan(0.5);
    expect(metricMax(m, 'api-gateway', 'error_rate', 0, T.deployUs)).toBe(0);
    const gateway = run.telemetry.spans.filter(
      (s) => s.service === 'api-gateway' && s.name === 'checkout' && s.endUs >= INC_FROM,
    );
    const fiveXx = gateway.filter((s) => Number(s.attributes[SPAN_ATTRS.httpStatus]) >= 500);
    expect(fiveXx.length / gateway.length).toBeGreaterThan(0.5);
    const shed = run.telemetry.logs.filter(
      (l) => l.service === 'checkout' && l.message.includes('queue full'),
    );
    expect(shed.length).toBeGreaterThan(10);
    expect(shed.every((l) => l.ts > T.deployUs)).toBe(true);
  });

  it('the shared pool also hurts requests that never touch checkout', () => {
    const stock = summarizeOutcomes(run.outcomes, 'stock', INC_FROM, INC_TO);
    const before = summarizeOutcomes(run.outcomes, 'stock', BASE_FROM, BASE_TO);
    expect(before.p99Us).toBeLessThan(50 * US_PER_MS);
    expect(stock.p99Us).toBeGreaterThan(1 * US_PER_S);
  });

  it('DB query EXECUTION time stays flat (the fact that rules out "the DB is slow")', () => {
    // Per statement: pure execution time (span duration minus DB queue wait) before vs during.
    const exec = (statement: string, from: number, to: number): number[] =>
      spansIn(run, SPAN_NAMES.dbQuery, from, to)
        .filter((s) => s.attributes[SPAN_ATTRS.dbStatement] === statement && s.status === 'ok')
        .map((s) => s.endUs - s.startUs - Number(s.attributes[SPAN_ATTRS.dbQueueWaitUs]));
    for (const statement of ['read-stock', 'load-cart']) {
      const before = exec(statement, BASE_FROM, BASE_TO);
      const during = exec(statement, INC_FROM, INC_TO);
      expect(during.length, statement).toBeGreaterThan(20);
      const ratio = percentile(during, 0.5) / percentile(before, 0.5);
      expect(ratio, statement).toBeGreaterThan(0.9);
      expect(ratio, statement).toBeLessThan(1.1);
    }
    const m = run.telemetry.metrics;
    const p95Ratio =
      metricMean(m, 'db', 'query_exec_p95', INC_FROM, INC_TO) /
      metricMean(m, 'db', 'query_exec_p95', BASE_FROM, BASE_TO);
    expect(p95Ratio).toBeGreaterThan(0.75);
    expect(p95Ratio).toBeLessThan(1.25);
    // The DB itself is nearly idle: fewer queries run than before, none queue at the executor.
    expect(metricMean(m, 'db', 'db_active_queries', INC_FROM, INC_TO)).toBeLessThan(
      metricMean(m, 'db', 'db_active_queries', BASE_FROM, BASE_TO),
    );
    expect(metricMax(m, 'db', 'queue_depth', 0, T.durationUs)).toBe(0);
  });

  it('pool saturation does not come after the latency rise', () => {
    const m = run.telemetry.metrics;
    const saturated = metricSeries(m, 'db', 'pool_in_use', T.deployUs).find(
      (p) => p.value >= 0.95 * POOL,
    );
    const slow = metricSeries(m, 'checkout', 'latency_p99', T.deployUs).find(
      (p) => p.value >= US_PER_S,
    );
    expect(saturated).toBeDefined();
    expect(slow).toBeDefined();
    expect(saturated?.ts).toBeLessThanOrEqual(slow?.ts ?? 0);
    // At span resolution: the first acquire that had to wait >100 ms ends before the first
    // checkout request that took >1 s ends.
    const firstWait = spansIn(run, SPAN_NAMES.poolAcquire, T.deployUs, T.durationUs)
      .filter((s) => s.endUs - s.startUs > 100 * US_PER_MS)
      .reduce((min, s) => Math.min(min, s.endUs), Infinity);
    const firstSlow = run.telemetry.spans
      .filter(
        (s) =>
          s.service === 'checkout' && s.name === 'place-order' && s.endUs - s.startUs > US_PER_S,
      )
      .reduce((min, s) => Math.min(min, s.endUs), Infinity);
    expect(firstWait).toBeLessThan(firstSlow);
  });

  it('holds for other seeds too (not tuned to one workload)', () => {
    for (const seed of [3, 7]) {
      const other = recordPoolExhaustion(seed);
      const r = runSimulation(other.config, other.workload);
      const b = baselineOf(r);
      expect(b.errorRate, `seed ${String(seed)}`).toBe(0);
      expect(b.p99Us).toBeGreaterThan(100 * US_PER_MS);
      expect(b.p99Us).toBeLessThan(150 * US_PER_MS);
      const utilization =
        metricMean(r.telemetry.metrics, 'db', 'pool_in_use', BASE_FROM, BASE_TO) / POOL;
      expect(utilization).toBeGreaterThan(0.35);
      expect(utilization).toBeLessThan(0.45);
      expect(incidentOf(r).errorRate).toBeGreaterThan(0.5);
      expect(incidentOf(r).p99Us).toBeGreaterThan(5 * US_PER_S);
      expect(
        metricMean(r.telemetry.metrics, 'db', 'pool_in_use', INC_FROM, INC_TO),
      ).toBeGreaterThan(0.98 * POOL);
      expect(r.stats.pool.acquireTimeouts).toBeGreaterThan(500);
    }
  });
});

describe('counterfactuals the engine must produce honestly (brief §5)', () => {
  it('pool 30 → 64 resolves the incident', () => {
    const r = replay([{ target: 'db.pool.capacity', from: 30, to: 64 }]);
    const inc = incidentOf(r);
    expect(inc.errorRate).toBeLessThan(0.01);
    expect(inc.p99Us).toBeLessThan(1 * US_PER_S);
    expect(r.stats.pool.acquireTimeouts).toBe(0);
    expect(metricMax(r.telemetry.metrics, 'db', 'pool_capacity', 0, T.durationUs)).toBe(64);
    // Before the deploy the pool size hardly mattered (only rare, millisecond-long waits).
    expect(Math.abs(baselineOf(r).p99Us / baselineOf(run).p99Us - 1)).toBeLessThan(0.01);
  });

  it('reverting the deploy resolves it completely', () => {
    const r = replay([{ revert: IDS.checkoutDeploy }]);
    const inc = incidentOf(r);
    expect(inc.errorRate).toBe(0);
    expect(inc.p99Us).toBeLessThan(150 * US_PER_MS);
    expect(r.telemetry.changeEvents.map((c) => c.id)).toEqual([IDS.inventoryTweak]);
    // Identical to the recorded run right up to the moment of the deploy.
    const before = (x: SimResult) => x.outcomes.filter((o) => o.endUs < T.deployUs);
    expect(before(r)).toEqual(before(run));
  });

  it('reducing checkout workers 60 → 20 mostly resolves it by shedding load earlier', () => {
    const r = replay([{ target: 'checkout.workers', from: 60, to: 20 }]);
    const inc = incidentOf(r);
    const original = incidentOf(run);
    expect(inc.errorRate).toBeLessThan(0.4);
    expect(inc.errorRate).toBeLessThan(original.errorRate / 2);
    expect(inc.p99Us).toBeLessThan(2 * US_PER_S);
    // No request waits out a timeout any more. What still fails is rejected at once by
    // checkout's full queue, before it can take a connection.
    expect(r.stats.pool.acquireTimeouts).toBe(0);
    expect(inc.timeoutRate).toBe(0);
    expect(r.stats.services['checkout']?.rejected).toBeGreaterThan(1000);
    expect(inc.errorRate).toBeGreaterThan(0.02); // "mostly", not fully
  });

  it('increasing the acquire timeout alone makes things worse', () => {
    const r = replay([{ target: 'db.acquireTimeoutUs', from: 5 * US_PER_S, to: 15 * US_PER_S }]);
    const inc = incidentOf(r);
    const original = incidentOf(run);
    expect(inc.errorRate).toBeGreaterThanOrEqual(original.errorRate);
    expect(inc.p99Us).toBeGreaterThan(original.p99Us);
    const ok = (x: SimResult) =>
      x.outcomes.filter((o) => o.type === 'checkout' && o.status === 'ok' && o.endUs >= INC_FROM)
        .length;
    expect(ok(r)).toBeLessThanOrEqual(ok(run));
    const stock = (x: SimResult) => summarizeOutcomes(x.outcomes, 'stock', INC_FROM, INC_TO);
    expect(stock(r).errorRate).toBeGreaterThan(stock(run).errorRate);
    expect(stock(r).p99Us).toBeGreaterThan(stock(run).p99Us);
  });

  it('a very large pool moves the bottleneck to the DB executor', () => {
    const r = replay([{ target: 'db.pool.capacity', to: 200 }]);
    const m = r.telemetry.metrics;
    expect(incidentOf(r).errorRate).toBeLessThan(0.01);
    // Nobody waits for a connection any more...
    expect(metricMax(m, 'db', 'pool_wait_queue', 0, T.durationUs)).toBe(0);
    expect(metricMax(m, 'db', 'pool_in_use', 0, T.durationUs)).toBeLessThan(200);
    // ...they wait at the DB instead: the executor runs near its limit with a standing queue,
    // and queries take longer than before even though nothing about the DB changed.
    const limit = rec.config.model.db.maxParallelQueries;
    expect(metricMean(m, 'db', 'db_active_queries', INC_FROM, INC_TO) / limit).toBeGreaterThan(0.8);
    expect(metricMean(m, 'db', 'queue_depth', INC_FROM, INC_TO)).toBeGreaterThan(2);
    expect(metricMean(m, 'db', 'query_exec_p95', INC_FROM, INC_TO)).toBeGreaterThan(
      1.2 * metricMean(m, 'db', 'query_exec_p95', BASE_FROM, BASE_TO),
    );
    // So latency does not return to baseline: the fix works but is not free.
    const reverted = replay([{ revert: IDS.checkoutDeploy }]);
    expect(incidentOf(r).p99Us).toBeGreaterThan(1.5 * incidentOf(reverted).p99Us);
  });

  it('counterfactuals are deterministic', () => {
    const patch: Patch[] = [{ target: 'db.pool.capacity', to: 64 }];
    expect(hashTelemetry(replay(patch).telemetry)).toBe(hashTelemetry(replay(patch).telemetry));
  });
});
