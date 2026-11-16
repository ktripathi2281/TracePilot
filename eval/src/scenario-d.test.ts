// Scenario D, bad-rollout-oomkill (brief §5): the simulator produces it, the analyzers find its
// signals without any LLM, and the replays behave as the ground truth records. Assertions follow
// what the model does; where that differs from the brief, the test says so (see NOTES.md).

import { ToolContext, computeTool } from '@tracepilot/agents';
import { Replayer, type ReplayRun } from '@tracepilot/replay';
import type { Patch } from '@tracepilot/schema';
import {
  BAD_ROLLOUT_TIMES,
  findTelemetryProblems,
  hashTelemetry,
  metricSeries,
  recordBadRollout,
  runSimulation,
  type SimResult,
} from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { beforeAll, describe, expect, it } from 'vitest';
import { readGroundTruth } from './ground-truth.ts';

const T = BAD_ROLLOUT_TIMES;
const truth = readGroundTruth('bad-rollout-oomkill');
const recording = recordBadRollout(42);
let sim: SimResult;
let store: TelemetryStore;
let incidentId: string;
let ctx: ToolContext;
let replayer: Replayer;
const runs = new Map<string, ReplayRun>();
const replay = (name: string, patches: Patch[]): ReplayRun => {
  let r = runs.get(name);
  if (r === undefined) runs.set(name, (r = replayer.replay(patches)));
  return r;
};
const finding = (tool: string, args: Record<string, unknown>, key: string) => {
  const f = computeTool(ctx, tool, args).findings.find((x) => x.key === key);
  if (f === undefined) throw new Error(`no finding ${key} from ${tool}`);
  return f;
};

beforeAll(() => {
  sim = runSimulation(recording.config, recording.workload);
  store = new TelemetryStore(':memory:');
  incidentId = store.ingest(sim.telemetry, { source: 'synthetic' }).incident.id;
  ctx = new ToolContext(store, incidentId);
  replayer = new Replayer({ incidentId, recording, telemetryHash: hashTelemetry(sim.telemetry) });
}, 120_000);

describe('the simulator produces scenario D', () => {
  it('is deterministic and its telemetry is valid', () => {
    const again = runSimulation(recording.config, recording.workload);
    expect(hashTelemetry(again.telemetry)).toBe(hashTelemetry(sim.telemetry));
    expect(findTelemetryProblems(sim.telemetry)).toEqual([]);
  });

  it('is healthy before the rollout: three ready pods, no pod events', () => {
    expect(sim.telemetry.podEvents.filter((e) => e.ts < T.rolloutUs)).toEqual([]);
    const ready = metricSeries(sim.telemetry.metrics, 'checkout', 'replicas_ready', 0, T.rolloutUs);
    expect(ready.every((p) => p.value === 3)).toBe(true);
  });

  it('after the rollout checkout pods are OOMKilled within seconds and crash-loop', () => {
    const events = sim.telemetry.podEvents;
    const first = events.find((e) => e.reason === 'OOMKilled');
    expect(first?.ts).toBeGreaterThan(T.rolloutUs);
    expect((first?.ts ?? Infinity) - T.rolloutUs).toBeLessThan(5_000_000);
    expect(new Set(events.filter((e) => e.reason === 'OOMKilled').map((e) => e.pod))).toEqual(
      new Set(['checkout-0', 'checkout-1', 'checkout-2']),
    );
    expect(events.filter((e) => e.reason === 'CrashLoopBackOff').length).toBeGreaterThan(5);
    const ready = metricSeries(
      sim.telemetry.metrics,
      'checkout',
      'replicas_ready',
      T.rolloutUs,
      T.durationUs,
    );
    expect(Math.min(...ready.map((p) => p.value))).toBe(0);
    expect(ready.filter((p) => p.value === 0).length).toBeGreaterThan(ready.length / 2);
  });

  it('errors follow; latency does NOT climb first (brief expected it would: see NOTES)', () => {
    const err = metricSeries(
      sim.telemetry.metrics,
      'api-gateway',
      'error_rate',
      T.rolloutUs + 60_000_000,
      T.durationUs,
    );
    expect(Math.min(...err.map((p) => p.value))).toBeGreaterThan(0.5);
    // Failed requests fail fast (502 from a dying pod, 503 with no ready pod), so p99 drops.
    const p99 = metricSeries(
      sim.telemetry.metrics,
      'api-gateway',
      'latency_p99',
      T.rolloutUs + 60_000_000,
      T.durationUs,
    );
    expect(Math.max(...p99.map((p) => p.value))).toBeLessThan(1_000_000);
  });

  it('has its red herrings: two harmless changes and a self-resolving DB-latency blip', () => {
    expect(sim.telemetry.changeEvents.map((c) => [c.id, c.service, c.ts])).toEqual([
      ['ev_1', 'payment', T.paymentTweakUs],
      ['ev_2', 'checkout', T.rolloutUs],
      ['ev_3', 'inventory', T.inventoryTweakUs],
    ]);
    const blip = metricSeries(
      sim.telemetry.metrics,
      'api-gateway',
      'error_rate',
      T.dbBlipStartUs,
      T.dbBlipEndUs + 30_000_000,
    );
    expect(Math.max(...blip.map((p) => p.value))).toBeGreaterThan(0);
    const after = metricSeries(
      sim.telemetry.metrics,
      'api-gateway',
      'error_rate',
      T.dbBlipEndUs + 60_000_000,
      T.rolloutUs,
    );
    expect(after.every((p) => p.value === 0)).toBe(true);
  });
});

describe('the analyzers find D’s signals without any LLM', () => {
  it('infers the incident window from telemetry, starting at the rollout', () => {
    expect(ctx.windows.incident.fromUs).toBe(T.rolloutUs);
  });

  it('pod events: OOMKilled and CrashLoopBackOff in the incident, none in the baseline, the first before the errors', () => {
    const oom = finding(
      'get_pod_events',
      { window: 'incident' },
      'pods.checkout.incident.oom_killed',
    );
    expect(oom.value).toBe(true);
    expect(
      finding('get_pod_events', { window: 'incident' }, 'pods.checkout.incident.crash_loop').value,
    ).toBe(true);
    expect(
      finding('get_pod_events', { window: 'baseline' }, 'pods.checkout.baseline.oom_killed').value,
    ).toBe(false);
    const errorOnset = ctx.anomalies.anomalies.find(
      (a) => a.service === 'api-gateway' && a.metric === 'error_rate' && a.status === 'ongoing',
    );
    expect(oom.occurredAt?.tsUs).toBeLessThanOrEqual(errorOnset?.onsetUs ?? 0);
  });

  it('scenario A’s pattern is absent: the pool is not saturated, no hold-and-wait, DB execution flat', () => {
    expect(
      finding('get_saturation', { window: 'incident' }, 'saturation.db.pool.incident.status').value,
    ).toBe('ok');
    expect(
      finding('analyze_hold_and_wait', { window: 'incident' }, 'hold_and_wait.incident.detected')
        .value,
    ).toBe(false);
    expect(
      finding('compare_windows', { subject: 'db_queries' }, 'db_exec.incident.flat').value,
    ).toBe(true);
  });

  it('change correlation: the rollout correlated, the later inventory change not; the payment change IS (by the DB blip)', () => {
    const verdict = (id: string) =>
      finding('correlate_changes', {}, `change_correlation.${id}.verdict`).value;
    expect(verdict('ev_2')).toBe('correlated');
    expect(verdict('ev_3')).toBe('none');
    // Correlation, not cause: the DB blip 95 s after ev_1 raises payment latency. Whether a
    // diagnosis blames ev_1 is what the eval harness checks.
    expect(verdict('ev_1')).toBe('correlated');
  });

  it('propagation does not count the database as failing because it receives less work', () => {
    const out = computeTool(ctx, 'analyze_propagation', {});
    expect(out.findings.find((f) => f.key === 'propagation.origin')?.value).not.toBe('db');
    expect(
      out.findings.some(
        (f) => f.key.startsWith('propagation.excluded.db.request_rate.') && f.value === 'less_work',
      ),
    ).toBe(true);
  });
});

describe('replays of scenario D (seed 42)', () => {
  it('reverting the rollout or raising the memory limit resolves it', () => {
    for (const fix of truth.fixes.resolves) {
      const r = replay(JSON.stringify(fix.patch), [fix.patch as Patch]);
      expect(r.verdict, JSON.stringify(fix.patch)).toBe('resolves');
      expect(r.replay.incident.failed).toBe(0);
    }
    expect(
      replay('mem768', [{ target: 'checkout.memoryLimit', to: 768 * 1_048_576 }]).verdict,
    ).toBe('resolves');
  });

  it('a bigger connection pool and reverting the red herrings do not', () => {
    expect(
      replay('pool64', [{ target: 'db.pool.capacity', to: 64 }]).replay.incident.errorRate,
    ).toBeGreaterThan(0.5);
    expect(replay('ev1', [{ revert: 'ev_1' }]).verdict).toBe('no_change');
    expect(replay('ev3', [{ revert: 'ev_3' }]).verdict).toBe('no_change');
  });

  it('more replicas: not a clean fix on this seed (the brief expected "only delays"; see NOTES)', () => {
    const r = replay('rep6', [{ target: 'checkout.replicas', to: 6 }]);
    expect(r.verdict).not.toBe('resolves');
    expect(r.replay.incident.errorRate).toBeLessThan(r.original.incident.errorRate);
  });

  it('identity replay is exact', () => {
    expect(replayer.identityHash).toBe(hashTelemetry(sim.telemetry));
  });
});
