// Scenario B, slow-dependency-retry-storm (brief §5): the simulator produces it, the analyzers find
// its signals without any LLM, and the replays behave as the ground truth records. Where the model
// differs from the brief's "retry storm", the test says so (see NOTES.md).

import { ToolContext, computeTool } from '@tracepilot/agents';
import { Replayer, type ReplayRun } from '@tracepilot/replay';
import type { Patch } from '@tracepilot/schema';
import {
  RETRY_STORM_TIMES,
  applyPatches,
  findTelemetryProblems,
  hashTelemetry,
  metricSeries,
  recordRetryStorm,
  runSimulation,
  summarizeOutcomes,
  type SimResult,
} from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { beforeAll, describe, expect, it } from 'vitest';
import { readGroundTruth } from './ground-truth.ts';

const T = RETRY_STORM_TIMES;
const truth = readGroundTruth('slow-dependency-retry-storm');
const recording = recordRetryStorm(42);
let sim: SimResult;
let ctx: ToolContext;
let replayer: Replayer;
const runs = new Map<string, ReplayRun>();
const replay = (name: string, patches: Patch[]): ReplayRun => {
  let r = runs.get(name);
  if (r === undefined) runs.set(name, (r = replayer.replay(patches)));
  return r;
};
const finding = (c: ToolContext, tool: string, args: Record<string, unknown>, key: string) => {
  const f = computeTool(c, tool, args).findings.find((x) => x.key === key);
  if (f === undefined) throw new Error(`no finding ${key} from ${tool}`);
  return f;
};
const contextOf = (s: SimResult): ToolContext => {
  const store = new TelemetryStore(':memory:');
  return new ToolContext(store, store.ingest(s.telemetry, { source: 'synthetic' }).incident.id);
};

beforeAll(() => {
  sim = runSimulation(recording.config, recording.workload);
  ctx = contextOf(sim);
  replayer = new Replayer({
    incidentId: ctx.incidentId,
    recording,
    telemetryHash: hashTelemetry(sim.telemetry),
  });
}, 120_000);

describe('the simulator produces scenario B', () => {
  it('is deterministic and its telemetry is valid', () => {
    expect(hashTelemetry(runSimulation(recording.config, recording.workload).telemetry)).toBe(
      hashTelemetry(sim.telemetry),
    );
    expect(findTelemetryProblems(sim.telemetry)).toEqual([]);
  });

  it('is healthy before the deploy and fails after it, checkout only', () => {
    const before = summarizeOutcomes(sim.outcomes, 'checkout', 8 * 60_000_000, T.deployUs);
    expect(before.errorRate).toBe(0);
    const after = summarizeOutcomes(
      sim.outcomes,
      'checkout',
      T.deployUs + 60_000_000,
      T.durationUs,
    );
    expect(after.errorRate).toBeGreaterThan(0.25);
    expect(after.p99Us).toBeGreaterThan(3_000_000);
    expect(summarizeOutcomes(sim.outcomes, 'stock', T.deployUs, T.durationUs).errorRate).toBe(0);
  });

  it('checkout’s workers and queue fill; payment does not run out of workers', () => {
    const queue = metricSeries(
      sim.telemetry.metrics,
      'checkout',
      'queue_depth',
      T.deployUs + 60_000_000,
      T.durationUs,
    );
    expect(Math.min(...queue.map((p) => p.value))).toBeGreaterThan(30);
    const payment = metricSeries(
      sim.telemetry.metrics,
      'payment',
      'in_flight',
      T.deployUs,
      T.durationUs,
    );
    expect(Math.max(...payment.map((p) => p.value))).toBeLessThan(80); // 2 replicas × 40 workers
  });

  it('has its red herrings: an inventory config change and an earlier, self-resolving payment blip', () => {
    expect(sim.telemetry.changeEvents.map((c) => c.id)).toEqual(['ev_1', 'ev_2']);
    const blip = metricSeries(
      sim.telemetry.metrics,
      'payment',
      'latency_p99',
      T.providerBlipStartUs,
      T.providerBlipEndUs + 10_000_000,
    );
    const base = metricSeries(
      sim.telemetry.metrics,
      'payment',
      'latency_p99',
      5 * 60_000_000,
      6 * 60_000_000,
    );
    expect(Math.max(...blip.map((p) => p.value))).toBeGreaterThan(
      2 * Math.max(...base.map((p) => p.value)),
    );
  });
});

describe('the analyzers find B’s signals without any LLM', () => {
  it('propagation: payment first, then checkout, then the gateway', () => {
    const out = computeTool(ctx, 'analyze_propagation', {});
    expect(out.findings.find((f) => f.key === 'propagation.origin')?.value).toBe('payment');
    const at = (n: string) =>
      out.findings.find((f) => f.key === `propagation.onset.${n}`)?.occurredAt?.tsUs ?? NaN;
    expect(at('payment')).toBeLessThanOrEqual(at('checkout'));
    expect(at('checkout')).toBeLessThanOrEqual(at('api-gateway'));
  });

  it('saturation: checkout workers saturated; the pool and payment are not', () => {
    const s = (r: string) =>
      finding(ctx, 'get_saturation', { window: 'incident' }, `saturation.${r}.incident.status`)
        .value;
    expect(s('checkout.workers')).toBe('saturated');
    expect(s('db.pool')).toBe('ok');
    expect(s('payment.workers')).not.toBe('saturated');
  });

  it('latency goes to external calls; DB execution is flat; no hold-and-wait', () => {
    expect(
      finding(
        ctx,
        'attribute_latency',
        { window: 'incident' },
        'attribution.incident.all.success.dominant',
      ).value,
    ).toBe('external');
    expect(
      finding(ctx, 'compare_windows', { subject: 'db_queries' }, 'db_exec.incident.flat').value,
    ).toBe(true);
    expect(
      finding(
        ctx,
        'analyze_hold_and_wait',
        { window: 'incident' },
        'hold_and_wait.incident.detected',
      ).value,
    ).toBe(false);
  });

  it('retries: payment’s callers retry in the incident, not at baseline', () => {
    expect(
      finding(ctx, 'get_retry_stats', { window: 'incident' }, 'retries.payment.incident.amplified')
        .value,
    ).toBe(true);
    expect(
      finding(ctx, 'get_retry_stats', { window: 'baseline' }, 'retries.payment.baseline.amplified')
        .value,
    ).toBe(false);
    expect(
      finding(ctx, 'get_retry_stats', { window: 'incident' }, 'retries.checkout.incident.amplified')
        .value,
    ).toBe(false);
  });

  it('change correlation: the payment deploy correlated, the inventory change not', () => {
    expect(finding(ctx, 'correlate_changes', {}, 'change_correlation.ev_2.verdict').value).toBe(
      'correlated',
    );
    expect(finding(ctx, 'correlate_changes', {}, 'change_correlation.ev_1.verdict').value).toBe(
      'none',
    );
  });
});

describe('replays of scenario B (seed 42)', () => {
  it('reverting the deploy resolves it', () => {
    const fix = truth.fixes.resolves[0];
    if (fix === undefined) throw new Error('no fix in ground truth');
    const r = replay('revert', [fix.patch as Patch]);
    expect(r.verdict).toBe('resolves');
    expect(r.replay.incident.failed).toBe(0);
  });

  it('a longer payment deadline only improves it: fewer retries, still slow', () => {
    const r = replay('timeout', [{ target: 'payment.timeoutUs', to: 3_000_000 }]);
    expect(r.verdict).toBe('improves');
    expect(r.replay.incident.errorRate).toBeGreaterThan(0.1);
  });

  it('more checkout workers makes it WORSE: the retries now overwhelm payment (the retry storm)', () => {
    const r = replay('workers', [{ target: 'checkout.workers', to: 120 }]);
    expect(r.verdict).toBe('worsens');
    expect(r.sideEffects.map((s) => `${s.kind} ${s.subject}`)).toContain(
      'new_bottleneck payment.workers',
    );
    // In the replayed telemetry, most of payment's requests are retries.
    const patched = runSimulation(
      applyPatches(recording.config, [{ target: 'checkout.workers', to: 120 }]),
      recording.workload,
    );
    const retried = finding(
      contextOf(patched),
      'get_retry_stats',
      { window: 'incident' },
      'retries.payment.incident.amplified',
    );
    expect(retried.value).toBe(true);
    const share = retried.derived.find((q) => q.name === 'retryShare')?.value ?? 0;
    expect(share).toBeGreaterThan(0.4);
  });

  it('more payment workers, a bigger pool and reverting the red herring change nothing', () => {
    expect(replay('payw', [{ target: 'payment.workers', to: 160 }]).verdict).toBe('no_change');
    expect(replay('pool', [{ target: 'db.pool.capacity', to: 64 }]).verdict).toBe('no_change');
    expect(replay('ev1', [{ revert: 'ev_1' }]).verdict).toBe('no_change');
  });
});
