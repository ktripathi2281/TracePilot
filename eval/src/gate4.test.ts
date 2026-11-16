// Gate 4 (brief §11): replay of the recommended patch improves the metrics; identity replay is
// still exact; the sweep shows a sensible knee. Plus the Phase 4 requirements: headline numbers
// come only from simulator output, the saturation analyzer runs on replayed telemetry, pinned
// knobs are annotated on change events, patches come from the CLI or a diagnosis file, symptom
// patches are compared with cause patches, and every result carries the notice.
//
// The diagnosis replayed here is the one the scripted investigation of scenario A produces (a test
// double plays the model; see scenario-a.ts). Its recommendations are revert ev_2 (cause) and
// db.pool.capacity=64 (symptom).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeHoldAndWait,
  buildTraces,
  inferIncidentWindows,
  toSeries,
} from '@tracepilot/analysis';
import {
  IdentityReplayError,
  REPLAY_NOTICE,
  Replayer,
  readRecommendations,
  requestStats,
  type RecommendationComparison,
  type ReplayRun,
  type Sweep,
} from '@tracepilot/replay';
import type { Patch } from '@tracepilot/schema';
import {
  applyPatches,
  hashTelemetry,
  recordPoolExhaustion,
  runSimulation,
  type Recording,
} from '@tracepilot/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadScenarioA, runScripted } from './scenario-a.ts';

let recording: Recording;
let recordedHash: string;
let incidentId: string;
let replayer: Replayer;
let comparison: RecommendationComparison;
let sweep: Sweep;
const runs = new Map<string, ReplayRun>();
const tmp = mkdtempSync(join(tmpdir(), 'tracepilot-gate4-'));

const run = (name: string, patches: Patch[]): ReplayRun => {
  let r = runs.get(name);
  if (r === undefined) runs.set(name, (r = replayer.replay(patches)));
  return r;
};

beforeAll(async () => {
  recording = recordPoolExhaustion(42);
  recordedHash = hashTelemetry(runSimulation(recording.config, recording.workload).telemetry);
  const a = loadScenarioA(42);
  incidentId = a.incidentId;
  expect(a.store.getIncident(incidentId).telemetryHash).toBe(recordedHash);
  replayer = new Replayer({ incidentId, recording, telemetryHash: recordedHash });

  // The scripted investigation's diagnosis, saved the way `tracepilot investigate` saves it.
  const { investigation } = await runScripted(a);
  const file = join(tmp, `${incidentId}.json`);
  writeFileSync(file, JSON.stringify(investigation));
  const { recommendations } = readRecommendations(file, incidentId);
  comparison = replayer.replayRecommendations(recommendations, file);
  sweep = replayer.sweep('db.pool.capacity', [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
}, 600_000);
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('identity replay', () => {
  it('reproduces the recorded telemetry exactly before anything is compared', () => {
    expect(replayer.identityHash).toBe(recordedHash);
    const identity = run('identity', []);
    expect(identity.replay.telemetryHash).toBe(recordedHash);
    expect(identity.identity).toEqual({ recordedHash, replayedHash: recordedHash, exact: true });
    expect(identity.verdict).toBe('no_change');
    expect(identity.headline.every((d) => d.direction === 'same' && d.change === 0)).toBe(true);
    expect(identity.sideEffects).toEqual([]);
    expect(identity.replay).toEqual(identity.original);
  });

  it('refuses to report anything when the recording does not reproduce its telemetry', () => {
    expect(() => new Replayer({ incidentId, recording, telemetryHash: 'f'.repeat(64) })).toThrow(
      IdentityReplayError,
    );
    const altered = structuredClone(recording);
    altered.workload.requests = altered.workload.requests.slice(1);
    expect(
      () => new Replayer({ incidentId, recording: altered, telemetryHash: recordedHash }),
    ).toThrow(/identity replay is not exact/);
  });

  it('a patch that sets a knob to its recorded value changes nothing at all', () => {
    const same = run('pool-30', [{ target: 'db.pool.capacity', to: 30 }]);
    expect(same.replay.telemetryHash).toBe(recordedHash);
    expect(same.verdict).toBe('no_change');
  });
});

describe('replaying the recommended patches (Gate 4)', () => {
  const row = (addresses: 'cause' | 'symptom') => {
    const r = comparison.rows.find((x) => x.addresses === addresses);
    if (r === undefined) throw new Error(`no ${addresses} recommendation`);
    return r;
  };

  it('takes the patches from the diagnosis file', () => {
    expect(comparison.rows.map((r) => [r.recommendationId, r.addresses, r.patch])).toEqual([
      ['rc_1', 'cause', 'revert ev_2'],
      ['rc_2', 'symptom', 'db.pool.capacity=64'],
    ]);
    for (const r of comparison.rows)
      expect(r.run.source).toMatchObject({
        kind: 'diagnosis',
        recommendationId: r.recommendationId,
      });
  });

  it('the cause patch (revert the deploy) resolves the incident with no new bottleneck', () => {
    const c = row('cause').run;
    expect(c.verdict).toBe('resolves');
    expect(c.replay.incident.failed).toBe(0);
    expect(c.replay.pool.acquireTimeouts).toBe(0);
    expect(c.original.incident.errorRate).toBeGreaterThan(0.5);
    const better = c.headline.filter((d) => d.direction === 'better').map((d) => d.key);
    expect(better).toEqual(
      expect.arrayContaining(['requestsFailed', 'errorRate', 'p99Us', 'goodputPerS', 'degradedUs']),
    );
    expect(
      c.sideEffects.filter((s) => s.kind === 'new_bottleneck' || s.kind === 'queue_formed'),
    ).toEqual([]);
    // The reverted deploy is gone from the replayed telemetry; the unrelated change is not.
    expect(c.changeEvents.map((e) => e.id)).toEqual(['ev_1']);
  });

  it('the symptom patch (pool 64) also stops the failures, but moves the pressure to the DB executor', () => {
    const s = row('symptom').run;
    expect(['resolves', 'improves']).toContain(s.verdict);
    expect(s.replay.incident.failed).toBe(0);
    const executor = s.sideEffects.find((e) => e.subject === 'db.executor');
    expect(executor?.kind).toBe('new_bottleneck');
    expect(executor?.replay?.queueMean).toBeGreaterThan(1);
    expect(s.sideEffects.find((e) => e.subject === 'db.pool')?.kind).toBe('relieved');
    expect(s.replay.db.totalQueueWaitUs).toBeGreaterThan(s.original.db.totalQueueWaitUs);
    // So the cause patch leaves the system faster than the symptom patch.
    expect(row('cause').run.replay.incident.p99Us).toBeLessThan(s.replay.incident.p99Us);
    expect(comparison.findings.join('\n')).toMatch(
      /rc_2 treats the symptom and rc_1 the cause: .*only rc_2 moves pressure to db\.executor/,
    );
  });

  it('headline numbers are the simulator’s own output, recomputed here independently', () => {
    for (const r of comparison.rows) {
      const direct = runSimulation(
        applyPatches(recording.config, [r.run.patches[0] as Patch]),
        recording.workload,
      );
      expect(hashTelemetry(direct.telemetry)).toBe(r.run.replay.telemetryHash);
      const w = r.run.windows.incident;
      expect(r.run.replay.incident).toEqual(requestStats(direct.outcomes, w));
      const failed = direct.outcomes.filter(
        (o) => o.endUs >= w.fromUs && o.endUs < w.toUs && o.status !== 'ok',
      );
      expect(r.run.headline.find((d) => d.key === 'requestsFailed')?.replay).toBe(failed.length);
      expect(r.run.replay.pool.acquireTimeouts).toBe(direct.stats.pool.acquireTimeouts);
    }
  });

  it('compares on windows inferred from the recorded telemetry, not from the scenario', () => {
    const original = runSimulation(recording.config, recording.workload);
    const w = inferIncidentWindows(toSeries(original.telemetry.metrics), {
      range: { fromUs: 0, toUs: recording.config.durationUs },
      entryServices: ['api-gateway'],
    });
    expect(replayer.windows).toEqual({ baseline: w?.baseline, incident: w?.incident });
  });
});

describe('side-effect check: the saturation analyzer on replayed telemetry', () => {
  it('reports the pool and checkout workers as bottlenecks in the original', () => {
    const pressed = replayer.original.saturation
      .filter((s) => s.status === 'saturated')
      .map((s) => s.resource);
    expect(pressed).toEqual(expect.arrayContaining(['db.pool', 'checkout.workers']));
  });

  it('a very large pool moves the bottleneck to the DB executor', () => {
    const big = run('pool-200', [{ target: 'db.pool.capacity', to: 200 }]);
    expect(big.replay.incident.failed).toBe(0);
    const executor = big.replay.saturation.find((s) => s.resource === 'db.executor');
    expect(['saturated', 'busy']).toContain(executor?.status);
    expect(big.sideEffects.map((e) => `${e.kind} ${e.subject}`)).toContain(
      'new_bottleneck db.executor',
    );
  });
});

describe('the brief’s expected qualitative outcomes (§5)', () => {
  it('fewer checkout workers mostly resolves it by shedding load earlier', () => {
    const r = run('workers-20', [{ target: 'checkout.workers', to: 20 }]);
    expect(r.verdict).toBe('improves');
    expect(r.replay.incident.errorRate).toBeLessThan(0.5 * r.original.incident.errorRate);
    expect(r.replay.incident.p99Us).toBeLessThan(0.2 * r.original.incident.p99Us);
    expect(r.replay.pool.acquireTimeouts).toBe(0);
  });

  it('a longer acquire timeout alone makes things worse', () => {
    const r = run('acquire-15s', [{ target: 'db.acquireTimeoutUs', to: 15_000_000 }]);
    expect(r.verdict).toBe('worsens');
    expect(r.replay.incident.failed).toBeGreaterThan(r.original.incident.failed);
  });

  it('reverting the red-herring config change changes nothing', () => {
    const r = run('revert-ev1', [{ revert: 'ev_1' }]);
    expect(r.verdict).toBe('no_change');
    expect(r.replay.incident).toEqual(r.original.incident);
  });
});

describe('pinned knobs in replayed telemetry', () => {
  it('a change event says which diff keys a patch held fixed, and at what value', () => {
    const r = run('workers-20', [{ target: 'checkout.workers', to: 20 }]);
    expect(r.pins).toEqual(['checkout.workers']);
    const deploy = r.changeEvents.find((e) => e.id === 'ev_2');
    expect(deploy?.pinned).toEqual({ workers: 20 });
    // The recorded diff itself is kept as recorded; the fan-out change still applied.
    expect(deploy?.diff['workers']).toEqual({ from: 20, to: 60 });
    expect(deploy?.pinned?.['params.reserveFanout']).toBeUndefined();
    // Recorded telemetry never carries the annotation.
    expect(run('identity', []).changeEvents.every((e) => e.pinned === undefined)).toBe(true);
  });

  it('the replayed deploy log line says the knob was pinned', () => {
    const r = runSimulation(
      applyPatches(recording.config, [{ target: 'checkout.workers', to: 20 }]),
      recording.workload,
    );
    const log = r.telemetry.logs.find((l) => l.fields['changeId'] === 'ev_2');
    expect(log?.fields['workers']).toBe('pinned at 20 (not applied: 20 -> 60)');
    expect(log?.fields['params.reserveFanout']).toBe('1 -> 4');
  });
});

describe('sweep (Gate 4)', () => {
  it('shows a sensible knee, where it resolves, and where the bottleneck moves', () => {
    expect(sweep.points.map((p) => p.value)).toEqual([
      20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
    ]);
    // Failures fall as the pool grows, until they are gone.
    const errors = sweep.points.map((p) => p.errorRate);
    for (let i = 2; i < errors.length; i++)
      expect(errors[i] ?? 1, String(sweep.points[i]?.value)).toBeLessThanOrEqual(
        (errors[i - 1] ?? 1) + 1e-9,
      );
    expect(sweep.points.find((p) => p.value === 30)?.verdict).toBe('no_change');
    expect(sweep.knee?.value).toBeGreaterThanOrEqual(50);
    expect(sweep.knee?.value).toBeLessThanOrEqual(70);
    expect(sweep.resolvesFrom).toBe(sweep.knee?.value);
    // Past the knee a larger pool buys nothing: p99 even creeps up as the DB executor queues.
    const after = sweep.points.filter((p) => p.value >= (sweep.knee?.value ?? 0));
    expect(Math.max(...after.map((p) => p.p99Us))).toBeLessThan(
      1.25 * Math.min(...after.map((p) => p.p99Us)),
    );
    expect(sweep.bottleneckShift?.resources).toEqual(['db.executor']);
    expect(sweep.bottleneckShift?.value).toBeLessThanOrEqual(sweep.knee?.value ?? 0);
    const top = sweep.points.at(-1);
    expect(top?.underPressure).toEqual(['db.executor']);
    expect(top?.dbQueueWaitUs).toBeGreaterThan(0);
  });
});

describe('the notice', () => {
  it('is carried by every replay, comparison and sweep result', () => {
    expect(REPLAY_NOTICE).toBe(
      'Simulated from a model of the system. Not a guarantee of production behavior.',
    );
    for (const r of [...runs.values(), ...comparison.rows.map((x) => x.run)])
      expect(r.notice).toBe(REPLAY_NOTICE);
    expect(comparison.notice).toBe(REPLAY_NOTICE);
    expect(sweep.notice).toBe(REPLAY_NOTICE);
  });
});

describe('model variant: checkout releases its connection before downstream calls (stretch)', () => {
  const VARIANT: Patch = { variant: 'release-connection-before-calls', service: 'checkout' };

  it('resolves the incident with the deploy still in place', () => {
    const r = run('variant', [VARIANT]);
    expect(r.verdict).toBe('resolves');
    expect(r.replay.incident.failed).toBe(0);
    expect(r.replay.pool.acquireTimeouts).toBe(0);
    expect(r.changeEvents.map((e) => e.id)).toEqual(['ev_1', 'ev_2']);
  });

  it('removes hold-and-wait from the replayed telemetry', () => {
    const config = applyPatches(recording.config, [VARIANT]);
    const result = runSimulation(config, recording.workload);
    const w = replayer.windows.incident;
    const traces = buildTraces(
      result.telemetry.spans.filter((s) => s.startUs >= w.fromUs + 60_000_000),
    );
    const hw = analyzeHoldAndWait(result.telemetry.metrics, traces, {
      fromUs: w.fromUs + 60_000_000,
      toUs: w.toUs,
    });
    expect(hw.detected).toBe(false);
    expect(hw.transactions.nestedWaitShare ?? 0).toBeLessThan(0.05);
  });

  it('draws the same random numbers as the recorded model', () => {
    const a = runSimulation(recording.config, recording.workload, { recordDraws: true }).draws;
    const b = runSimulation(applyPatches(recording.config, [VARIANT]), recording.workload, {
      recordDraws: true,
    }).draws;
    if (a === undefined || b === undefined) throw new Error('draws not recorded');
    let common = 0;
    let mismatches = 0;
    for (const [key, value] of a) {
      const other = b.get(key);
      if (other === undefined) continue;
      common++;
      if (other !== value) mismatches++;
    }
    expect(common).toBeGreaterThan(0.9 * a.size);
    expect(mismatches).toBe(0);
  });

  it('is rejected for a service with no such transaction', () => {
    expect(() =>
      replayer.replay([{ variant: 'release-connection-before-calls', service: 'inventory' }]),
    ).toThrow(/inventory has no transaction that holds its connection across other steps/);
  });
});
