// Simulator validity tests (brief §3). These gate Phase 1 and are the most important tests in
// the repo: if any of them fails, replay results cannot be trusted.
import { US_PER_MIN, US_PER_S } from '@tracepilot/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { runSimulation, type SimResult } from './engine.ts';
import { hashTelemetry } from './hash.ts';
import { applyPatches } from './knobs.ts';
import { Recording, type SimConfig, type Step } from './model.ts';
import { uniform } from './rng.ts';
import {
  poolExhaustionConfig,
  poolExhaustionWorkloadSpec,
  recordPoolExhaustion,
} from './scenarios/pool-exhaustion.ts';
import { metricMean } from './summary.ts';
import { generateWorkload } from './workload.ts';

const SEED = 42;

/**
 * Scenario A compressed for speed: same system, deploy after 1 minute instead of 10, no red
 * herrings. Used where a test needs the incident dynamics but not the full timeline.
 */
function shortIncident(durationUs = 3 * US_PER_MIN, deployAtUs = US_PER_MIN): SimConfig {
  const config = poolExhaustionConfig({ durationUs, redHerrings: false });
  for (const change of config.changes) change.ts = deployAtUs;
  return config;
}

describe('1. determinism', () => {
  let recording: Recording;
  let first: SimResult;
  beforeAll(() => {
    recording = recordPoolExhaustion(SEED);
    first = runSimulation(recording.config, recording.workload);
  });

  it('same scenario + seed + workload produces byte-identical telemetry', () => {
    const again = recordPoolExhaustion(SEED);
    expect(again).toEqual(recording);
    const second = runSimulation(again.config, again.workload);
    expect(hashTelemetry(second.telemetry)).toBe(hashTelemetry(first.telemetry));
    expect(second.outcomes).toEqual(first.outcomes);
    expect(second.stats).toEqual(first.stats);
  });

  it('a different seed produces different telemetry', () => {
    const other = recordPoolExhaustion(SEED + 1);
    const result = runSimulation(other.config, other.workload);
    expect(hashTelemetry(result.telemetry)).not.toBe(hashTelemetry(first.telemetry));
  });

  it('2. identity replay: a saved and reloaded recording reproduces the telemetry exactly', () => {
    const reloaded = Recording.parse(JSON.parse(JSON.stringify(recording)));
    const replay = runSimulation(reloaded.config, reloaded.workload);
    expect(hashTelemetry(replay.telemetry)).toBe(hashTelemetry(first.telemetry));
    expect(replay.outcomes).toEqual(first.outcomes);
    // An empty patch list is the identity too.
    const unpatched = runSimulation(applyPatches(reloaded.config, []), reloaded.workload);
    expect(hashTelemetry(unpatched.telemetry)).toBe(hashTelemetry(first.telemetry));
  });
});

describe('3. monotonicity of pool capacity', () => {
  /** Total acquire wait for the short incident with the given pool capacity. */
  const run = (config: SimConfig, capacity: number): SimResult => {
    const workload = generateWorkload(poolExhaustionWorkloadSpec(config.durationUs), SEED);
    return runSimulation(
      applyPatches(config, [{ target: 'db.pool.capacity', to: capacity }]),
      workload,
    );
  };

  describe('without hold-and-wait (pure queueing)', () => {
    // Same system, but checkout's transaction is flattened: no connection is held while waiting
    // for another one. Deadlines and queue limits are lifted and the DB executor is unconstrained,
    // so the pool is the only thing that can make a query wait and every request completes.
    const ladder = [8, 12, 16, 20, 22, 24, 26, 28, 32, 40, 64];
    let results: SimResult[];
    beforeAll(() => {
      const config = shortIncident(2 * US_PER_MIN, 20 * US_PER_S);
      const placeOrder = config.model.services['checkout']?.operations['place-order'];
      if (placeOrder === undefined) throw new Error('scenario changed');
      placeOrder.steps = placeOrder.steps.flatMap((s): Step[] =>
        s.kind === 'transaction' ? s.steps : [s],
      );
      config.model.db.maxParallelQueries = 10_000;
      config.model.db.acquireTimeoutUs = 3600 * US_PER_S;
      for (const svc of Object.values(config.model.services)) {
        svc.timeoutUs = 3600 * US_PER_S;
        svc.queueLimit = 1_000_000;
      }
      results = ladder.map((c) => run(config, c));
    });
    const each = (f: (r: SimResult) => number): number[] => results.map(f);
    const step = (values: number[], ok: (next: number, prev: number) => boolean): void => {
      for (let i = 1; i < values.length; i++) {
        const where = `capacity ${String(ladder[i - 1])} -> ${String(ladder[i])}`;
        expect(ok(values[i] as number, values[i - 1] as number), where).toBe(true);
      }
    };

    it('more connections never increase the average wait of an acquire', () => {
      const meanWait = each((r) => r.stats.pool.totalAcquireWaitUs / r.stats.pool.acquireCount);
      step(meanWait, (next, prev) => next <= prev);
      expect(meanWait[0]).toBeGreaterThan(100_000); // 8 connections: every acquire waits >100 ms
      expect(meanWait.at(-1)).toBeLessThan(10); // 64 connections: effectively no wait
    });

    it('more connections never increase time in system, and never reduce completed work', () => {
      const inSystem = each((r) => {
        const gw = r.stats.timeAverages.services['api-gateway'];
        return gw === undefined ? NaN : gw.inFlight + gw.queueDepth;
      });
      step(inSystem, (next, prev) => next <= prev);
      step(
        each((r) => r.stats.requestsFinished),
        (next, prev) => next >= prev,
      );
    });

    it('TOTAL acquire wait never increases once the pool no longer throttles demand', () => {
      // The brief's literal property. It needs one precondition: the same acquires must be
      // attempted. Below the offered load (~19 connections here) the pool itself throttles the
      // system: requests are stuck upstream and issue fewer acquires (about half as many at 8
      // connections as at 22), so the TOTAL can be lower with a smaller pool even though every
      // single acquire waits longer (previous tests). From 22 connections up the same acquires
      // are attempted and the total falls at every step.
      const from = ladder.indexOf(22);
      const attempts = each((r) => r.stats.pool.acquireCount);
      const total = each((r) => r.stats.pool.totalAcquireWaitUs);
      expect(attempts[0]).toBeLessThan(0.6 * (attempts[from] as number));
      for (let i = from + 1; i < ladder.length; i++) {
        const where = `capacity ${String(ladder[i - 1])} -> ${String(ladder[i])}`;
        expect((attempts[i] as number) / (attempts[i - 1] as number), where).toBeGreaterThan(0.999);
        expect(total[i], where).toBeLessThan(total[i - 1] as number);
      }
      expect(total.at(-1)).toBeLessThan(US_PER_S);
    });
  });

  it('scenario A (with hold-and-wait): growing the pool from the incident size removes acquire wait...', () => {
    const ladder = [30, 64, 120, 200];
    const results = ladder.map((c) => run(shortIncident(), c));
    const waits = results.map((r) => r.stats.pool.totalAcquireWaitUs);
    for (let i = 1; i < waits.length; i++)
      expect(waits[i]).toBeLessThanOrEqual(waits[i - 1] as number);
    expect(waits.at(-1)).toBe(0);

    // ...but (the DB-executor effect, brief §3) the wait does not vanish, it MOVES: queries that
    // no longer wait for a connection now queue at the DB executor, which only runs
    // maxParallelQueries at once. So DB queue wait grows with the pool.
    const dbWaits = results.map((r) => r.stats.db.totalQueueWaitUs);
    expect(dbWaits[0]).toBeLessThan(US_PER_S);
    for (let i = 1; i < dbWaits.length; i++)
      expect(dbWaits[i]).toBeGreaterThanOrEqual(dbWaits[i - 1] as number);
    expect(dbWaits.at(-1)).toBeGreaterThan(60 * US_PER_S);
  });

  it('with an unconstrained DB executor the same growth leaves no wait anywhere', () => {
    const config = shortIncident();
    config.model.db.maxParallelQueries = 10_000;
    const r = run(config, 200);
    expect(r.stats.pool.totalAcquireWaitUs).toBe(0);
    expect(r.stats.db.totalQueueWaitUs).toBe(0);
  });
});

describe("4. conservation and Little's law", () => {
  let config: SimConfig;
  let r: SimResult;
  beforeAll(() => {
    // Steady state: baseline system for 4 minutes, no deploy, no disturbances.
    config = poolExhaustionConfig({
      durationUs: 4 * US_PER_MIN,
      deploy: false,
      redHerrings: false,
    });
    r = runSimulation(
      config,
      generateWorkload(poolExhaustionWorkloadSpec(config.durationUs), SEED),
    );
  });

  it('every arrival is accounted for', () => {
    expect(r.stats.requestsArrived).toBe(r.stats.requestsFinished + r.stats.requestsUnfinished);
    expect(r.outcomes).toHaveLength(r.stats.requestsFinished);
    expect(r.stats.requestsUnfinished).toBeLessThan(50);
    expect(r.stats.services['api-gateway']?.responses).toBe(r.stats.requestsFinished);
  });

  it('L = λW at every service: time-average in system = throughput × mean latency', () => {
    for (const [name, svc] of Object.entries(r.stats.services)) {
      const avg = r.stats.timeAverages.services[name];
      if (avg === undefined) throw new Error(`no averages for ${name}`);
      const L = avg.inFlight + avg.queueDepth; // integrated from gauge changes
      const lambda = svc.responses / config.durationUs; // counted at responses
      const W = svc.totalLatencyUs / svc.responses; // summed per request
      expect(L, name).toBeGreaterThan(0);
      expect(Math.abs(L - lambda * W) / L, name).toBeLessThan(0.01);
    }
  });

  it('L = λW at the pool and at the DB executor', () => {
    const { pool, db, timeAverages } = r.stats;
    const poolL = timeAverages.poolInUse;
    const poolLambdaW =
      (pool.acquireCount / config.durationUs) * (pool.totalHoldUs / pool.acquireCount);
    expect(Math.abs(poolL - poolLambdaW) / poolL).toBeLessThan(0.01);
    const dbL = timeAverages.dbActive;
    const dbLambdaW = (db.queryCount / config.durationUs) * (db.totalExecUs / db.queryCount);
    expect(Math.abs(dbL - dbLambdaW) / dbL).toBeLessThan(0.01);
  });

  it('point-sampled gauges in the metrics agree with the exact time-averages', () => {
    const sampled = metricMean(r.telemetry.metrics, 'db', 'pool_in_use', 0, config.durationUs);
    expect(
      Math.abs(sampled - r.stats.timeAverages.poolInUse) / r.stats.timeAverages.poolInUse,
    ).toBeLessThan(0.15);
  });

  it('nothing leaks: after an incident and a drain period every resource is free', () => {
    // 2 minutes of traffic through the full incident (timeouts, cancellations, rejections),
    // then 60 s with no arrivals. Anything still held would be a leak in the cancellation paths.
    const trafficUs = 2 * US_PER_MIN;
    const incident = shortIncident(trafficUs + 60 * US_PER_S, 20 * US_PER_S);
    const workload = generateWorkload(poolExhaustionWorkloadSpec(trafficUs), SEED);
    const drainedRun = runSimulation(incident, workload);
    expect(drainedRun.stats.pool.acquireTimeouts).toBeGreaterThan(100); // the incident really happened
    expect(drainedRun.stats.requestsUnfinished).toBe(0);
    expect(drainedRun.stats.finalState).toEqual({
      poolInUse: 0,
      poolWaiting: 0,
      dbActive: 0,
      dbQueued: 0,
      busyWorkers: 0,
      queuedRequests: 0,
    });
  });
});

describe('5. isolation of randomness (common random numbers)', () => {
  it('changing db.pool.capacity leaves every request’s drawn service times unchanged', () => {
    const config = shortIncident();
    const workload = generateWorkload(poolExhaustionWorkloadSpec(config.durationUs), SEED);
    const jammed = runSimulation(config, workload, { recordDraws: true });
    const fixed = runSimulation(
      applyPatches(config, [{ target: 'db.pool.capacity', to: 64 }]),
      workload,
      {
        recordDraws: true,
      },
    );
    const a = jammed.draws;
    const b = fixed.draws;
    if (a === undefined || b === undefined) throw new Error('draws not recorded');
    // The two runs behave very differently...
    expect(jammed.stats.pool.acquireTimeouts).toBeGreaterThan(100);
    expect(fixed.stats.pool.acquireTimeouts).toBe(0);
    // ...yet every draw both runs made (same request, same step) has the same value. The jammed
    // run makes fewer draws only because failed requests never reach their later steps.
    let common = 0;
    let mismatches = 0;
    for (const [key, value] of a) {
      const other = b.get(key);
      if (other === undefined) continue;
      common++;
      if (other !== value) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(common).toBeGreaterThan(50_000);
    expect(b.size).toBeGreaterThan(a.size);
  });

  it('adding fan-out copies does not disturb the draws of the existing copy or of other requests', () => {
    const config = shortIncident(US_PER_MIN, 10 * US_PER_MIN); // deploy never happens
    const workload = generateWorkload(poolExhaustionWorkloadSpec(config.durationUs), SEED);
    const one = runSimulation(config, workload, { recordDraws: true }).draws;
    const wide = structuredClone(config);
    (wide.model.services['checkout'] as { params: Record<string, number> }).params[
      'reserveFanout'
    ] = 4;
    wide.model.db.pool.capacity = 200;
    const four = runSimulation(wide, workload, { recordDraws: true }).draws;
    if (one === undefined || four === undefined) throw new Error('draws not recorded');
    let checked = 0;
    for (const [key, value] of one) {
      const other = four.get(key);
      if (other === undefined) continue; // request cut off by the end of the run in one of them
      expect(other).toBe(value);
      checked++;
    }
    expect(checked).toBeGreaterThan(0.95 * one.size);
    expect(four.size).toBeGreaterThan(one.size);
  });

  it('a draw is a pure function of (seed, requestId, label)', () => {
    expect(uniform(1, 2, 'a/b')).toBe(uniform(1, 2, 'a/b'));
    expect(uniform(1, 2, 'a/b')).not.toBe(uniform(1, 2, 'a/c'));
    expect(uniform(1, 2, 'a/b')).not.toBe(uniform(1, 3, 'a/b'));
    expect(uniform(1, 2, 'a/b')).not.toBe(uniform(2, 2, 'a/b'));
    expect(uniform(1, 2, 'a/b', 0)).not.toBe(uniform(1, 2, 'a/b', 1));
  });
});
