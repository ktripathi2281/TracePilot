// Scenario C, cache-hit-rate-drop (brief §5): the simulator produces it, the analyzers find its
// signals without any LLM, and the replays behave as the ground truth records.

import { ToolContext, computeTool } from '@tracepilot/agents';
import { Replayer, type ReplayRun } from '@tracepilot/replay';
import type { Patch } from '@tracepilot/schema';
import {
  CACHE_DROP_TIMES,
  findTelemetryProblems,
  hashTelemetry,
  metricSeries,
  recordCacheDrop,
  runSimulation,
  summarizeOutcomes,
  type SimResult,
} from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { beforeAll, describe, expect, it } from 'vitest';
import { readGroundTruth } from './ground-truth.ts';

const T = CACHE_DROP_TIMES;
const truth = readGroundTruth('cache-hit-rate-drop');
const recording = recordCacheDrop(42);
let sim: SimResult;
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
  const store = new TelemetryStore(':memory:');
  ctx = new ToolContext(store, store.ingest(sim.telemetry, { source: 'synthetic' }).incident.id);
  replayer = new Replayer({
    incidentId: ctx.incidentId,
    recording,
    telemetryHash: hashTelemetry(sim.telemetry),
  });
}, 120_000);

describe('the simulator produces scenario C', () => {
  it('is deterministic and its telemetry is valid', () => {
    expect(hashTelemetry(runSimulation(recording.config, recording.workload).telemetry)).toBe(
      hashTelemetry(sim.telemetry),
    );
    expect(findTelemetryProblems(sim.telemetry)).toEqual([]);
  });

  it('the cache hit ratio collapses at the deploy and stays down', () => {
    const before = metricSeries(
      sim.telemetry.metrics,
      'inventory',
      'cache_hit_ratio',
      60_000_000,
      T.deployUs,
    );
    const after = metricSeries(
      sim.telemetry.metrics,
      'inventory',
      'cache_hit_ratio',
      T.deployUs + 30_000_000,
      T.durationUs,
    );
    expect(Math.min(...before.map((p) => p.value))).toBeGreaterThan(0.9);
    expect(Math.max(...after.map((p) => p.value))).toBeLessThan(0.1);
  });

  it('the database saturates and latency climbs for stock and checkout', () => {
    const queue = metricSeries(
      sim.telemetry.metrics,
      'db',
      'queue_depth',
      T.deployUs + 30_000_000,
      T.durationUs,
    );
    expect(Math.min(...queue.map((p) => p.value))).toBeGreaterThan(5);
    const stockBefore = summarizeOutcomes(sim.outcomes, 'stock', 5 * 60_000_000, T.deployUs);
    const stockAfter = summarizeOutcomes(
      sim.outcomes,
      'stock',
      T.deployUs + 60_000_000,
      T.durationUs,
    );
    expect(stockAfter.p99Us).toBeGreaterThan(3 * stockBefore.p99Us);
    const checkout = summarizeOutcomes(
      sim.outcomes,
      'checkout',
      T.deployUs + 60_000_000,
      T.durationUs,
    );
    expect(checkout.p99Us).toBeGreaterThan(1_000_000);
    expect(checkout.errorRate).toBeGreaterThan(0.1);
  });

  it('has its red herrings: an earlier inventory change and a self-resolving payment blip', () => {
    expect(sim.telemetry.changeEvents.map((c) => [c.id, c.service])).toEqual([
      ['ev_1', 'inventory'],
      ['ev_2', 'inventory'],
    ]);
  });
});

describe('the analyzers find C’s signals without any LLM', () => {
  it('the cache degraded in the incident, not at baseline, from right after the deploy', () => {
    const c = finding(
      'get_cache_stats',
      { window: 'incident' },
      'cache.inventory.incident.degraded',
    );
    expect(c.value).toBe(true);
    expect((c.occurredAt?.tsUs ?? 0) - T.deployUs).toBeLessThanOrEqual(5_000_000);
    expect(
      finding('get_cache_stats', { window: 'baseline' }, 'cache.inventory.baseline.degraded').value,
    ).toBe(false);
  });

  it('the pool and the DB executor are saturated with busy connections: not hold-and-wait, not a slower DB', () => {
    expect(
      finding('get_saturation', { window: 'incident' }, 'saturation.db.pool.incident.status').value,
    ).toBe('saturated');
    expect(
      finding('get_saturation', { window: 'incident' }, 'saturation.db.executor.incident.status')
        .value,
    ).toBe('saturated');
    expect(
      finding('analyze_hold_and_wait', { window: 'incident' }, 'hold_and_wait.incident.idle_held')
        .value,
    ).toBe(false);
    expect(
      finding('analyze_hold_and_wait', { window: 'incident' }, 'hold_and_wait.incident.detected')
        .value,
    ).toBe(false);
    expect(
      finding('compare_windows', { subject: 'db_queries' }, 'db_exec.incident.flat').value,
    ).toBe(true);
  });

  it('change correlation: the deploy correlated (via the hit ratio), the earlier inventory change not', () => {
    const ev2 = finding('correlate_changes', {}, 'change_correlation.ev_2.verdict');
    expect(ev2.value).toBe('correlated');
    expect(ev2.statement).toMatch(/inventory itself shows cache_hit_ratio down/);
    expect(finding('correlate_changes', {}, 'change_correlation.ev_1.verdict').value).toBe('none');
  });

  it('propagation names the database, where the failure shows, not the cache that caused it (a limitation)', () => {
    expect(finding('analyze_propagation', {}, 'propagation.origin').value).toBe('db');
  });
});

describe('replays of scenario C (seed 42)', () => {
  it('reverting the deploy resolves it and relieves the pool, the DB executor and checkout', () => {
    const fix = truth.fixes.resolves[0];
    if (fix === undefined) throw new Error('no fix in ground truth');
    const r = replay('revert', [fix.patch as Patch]);
    expect(r.verdict).toBe('resolves');
    expect(
      r.sideEffects
        .filter((s) => s.kind === 'relieved')
        .map((s) => s.subject)
        .sort(),
    ).toEqual(['checkout.workers', 'db.executor', 'db.pool']);
  });

  it('a much larger cache only improves it: the new keys warm one miss at a time', () => {
    const r = replay('cache', [{ target: 'cache.capacity', to: 500_000 }]);
    expect(r.verdict).toBe('improves');
    expect(r.replay.incident.p99Us).toBeGreaterThan(500_000);
  });

  it('a bigger pool, more inventory workers or reverting the red herring do not', () => {
    for (const [name, p] of [
      ['pool', { target: 'db.pool.capacity', to: 64 }],
      ['inv', { target: 'inventory.workers', to: 512 }],
      ['ev1', { revert: 'ev_1' }],
    ] as [string, Patch][]) {
      const r = replay(name, [p]);
      expect(r.replay.incident.errorRate, name).toBeCloseTo(r.original.incident.errorRate, 3);
      expect(r.verdict, name).not.toBe('resolves');
    }
  });
});
