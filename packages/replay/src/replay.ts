// Counterfactual replay (brief §7).
//
// A replay takes an incident's recording (system model + recorded workload + seed), applies
// patches, and runs the SAME simulator. Per-request random streams are keyed by request and step,
// so every difference between the original and the replay comes from the patch, not from noise.
//
// Before anything is compared, the recording is replayed with no patch and its telemetry hash
// must equal the recorded one (identity replay). If it does not, the replay engine cannot be
// trusted and nothing is reported.
//
// Every number in a ReplayRun comes from simulator output: request outcomes, simulator counters,
// and the Phase 2 saturation analyzer run on the replayed telemetry. Nothing comes from a model.

import { createHash } from 'node:crypto';
import { inferIncidentWindows, toSeries, type Window } from '@tracepilot/analysis';
import type { Recommendation } from '@tracepilot/schema';
import { ChangeEvent, Patch, formatPatch, type SetPatch } from '@tracepilot/schema';
import {
  UnsupportedKnobError,
  applyPatches,
  hashTelemetry,
  runSimulation,
  type Recording,
  type SimResult,
} from '@tracepilot/sim';
import { z } from 'zod';
import { REPLAY_NOTICE } from './notice.ts';
import {
  PRESSURE,
  ResourceState,
  RunSummary,
  summarizeRun,
  symptomThresholds,
  type SymptomThresholds,
} from './summary.ts';

export class IdentityReplayError extends Error {}

const WindowSchema = z.strictObject({ fromUs: z.number(), toUs: z.number() });

export const Delta = z.strictObject({
  key: z.string(),
  label: z.string(),
  unit: z.enum(['count', 'ratio', 'us', 'req/s']),
  original: z.number(),
  replay: z.number(),
  change: z.number(),
  /** Relative change, null when the original is 0. */
  relative: z.number().nullable(),
  direction: z.enum(['better', 'worse', 'same']),
});
export type Delta = z.infer<typeof Delta>;

export const SideEffect = z.strictObject({
  kind: z.enum(['new_bottleneck', 'queue_formed', 'relieved', 'more_errors']),
  subject: z.string(),
  message: z.string(),
  original: ResourceState.nullable(),
  replay: ResourceState.nullable(),
});
export type SideEffect = z.infer<typeof SideEffect>;

export const Verdict = z.enum(['resolves', 'improves', 'mixed', 'no_change', 'worsens']);
export type Verdict = z.infer<typeof Verdict>;

export const ReplaySource = z.union([
  z.strictObject({ kind: z.literal('cli') }),
  z.strictObject({
    kind: z.literal('diagnosis'),
    file: z.string(),
    recommendationId: z.string(),
    addresses: z.enum(['cause', 'symptom']),
    title: z.string(),
  }),
  z.strictObject({ kind: z.literal('sweep'), param: z.string() }),
]);
export type ReplaySource = z.infer<typeof ReplaySource>;

export const ReplayRun = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal('replay'),
  id: z.string(),
  /** Shown with every replay result (brief §7). */
  notice: z.literal(REPLAY_NOTICE),
  incidentId: z.string(),
  patches: z.array(Patch),
  source: ReplaySource,
  /** Knobs held fixed for the whole run: scheduled changes did not alter them. */
  pins: z.array(z.string()),
  identity: z.strictObject({
    recordedHash: z.string(),
    replayedHash: z.string(),
    exact: z.literal(true),
  }),
  windows: z.strictObject({ baseline: WindowSchema, incident: WindowSchema }),
  thresholds: z.strictObject({
    bucketUs: z.number(),
    maxErrorRate: z.number(),
    maxP99Us: z.number(),
  }),
  original: RunSummary,
  replay: RunSummary,
  headline: z.array(Delta),
  verdict: Verdict,
  sideEffects: z.array(SideEffect),
  /** Change events of the replayed telemetry; `pinned` marks diff keys a patch held fixed. */
  changeEvents: z.array(ChangeEvent),
});
export type ReplayRun = z.infer<typeof ReplayRun>;

// ---- headline deltas -----------------------------------------------------------------------

interface Metric {
  key: string;
  label: string;
  unit: Delta['unit'];
  higherIsBetter?: boolean;
  get: (s: RunSummary) => number;
}

const HEADLINE: readonly Metric[] = [
  { key: 'requestsFailed', label: 'requests failed', unit: 'count', get: (s) => s.incident.failed },
  { key: 'errorRate', label: 'error rate', unit: 'ratio', get: (s) => s.incident.errorRate },
  { key: 'p50Us', label: 'latency p50', unit: 'us', get: (s) => s.incident.p50Us },
  { key: 'p99Us', label: 'latency p99', unit: 'us', get: (s) => s.incident.p99Us },
  {
    key: 'goodputPerS',
    label: 'successful requests per second',
    unit: 'req/s',
    higherIsBetter: true,
    get: (s) => s.incident.goodputPerS,
  },
  { key: 'degradedUs', label: 'time degraded', unit: 'us', get: (s) => s.degradedUs },
  {
    key: 'acquireTimeouts',
    label: 'connection acquire timeouts (run)',
    unit: 'count',
    get: (s) => s.pool.acquireTimeouts,
  },
  {
    key: 'acquireWaitUs',
    label: 'total wait for a connection (run)',
    unit: 'us',
    get: (s) => s.pool.totalAcquireWaitUs,
  },
  {
    key: 'dbQueueWaitUs',
    label: 'total wait at the DB executor (run)',
    unit: 'us',
    get: (s) => s.db.totalQueueWaitUs,
  },
];

/** Changes within 1 % (or below one unit of the smallest meaningful size) count as "same". */
function direction(m: Metric, original: number, replay: number): Delta['direction'] {
  const diff = replay - original;
  const floor = m.unit === 'ratio' ? 0.001 : m.unit === 'us' ? 1_000 : m.unit === 'req/s' ? 0.1 : 1;
  if (Math.abs(diff) < Math.max(floor, 0.01 * Math.abs(original))) return 'same';
  const lowerIsBetter = m.higherIsBetter !== true;
  return diff < 0 === lowerIsBetter ? 'better' : 'worse';
}

export function headlineDeltas(original: RunSummary, replay: RunSummary): Delta[] {
  return HEADLINE.map((m) => {
    const o = m.get(original);
    const r = m.get(replay);
    return {
      key: m.key,
      label: m.label,
      unit: m.unit,
      original: o,
      replay: r,
      change: r - o,
      relative: o === 0 ? null : (r - o) / o,
      direction: direction(m, o, r),
    };
  });
}

/**
 * The verdict rubric, from the deltas only:
 *   resolves  — at most a transient (2 metric buckets) of degraded time left in the incident
 *               window, and errors under the threshold
 *   worsens   — more failures or more degraded time, or a worse p99 without fewer failures
 *   improves  — fewer failures or less degraded time, and p99 not worse
 *   no_change — every headline delta is "same"
 *   mixed     — anything else
 */
/** Degraded buckets a resolving replay may still have: the moment of the change itself. */
export const TRANSIENT_BUCKETS = 2;

export function verdictOf(
  deltas: readonly Delta[],
  replay: RunSummary,
  t: SymptomThresholds,
): Verdict {
  const d = (key: string): Delta['direction'] =>
    deltas.find((x) => x.key === key)?.direction ?? 'same';
  if (deltas.every((x) => x.direction === 'same')) return 'no_change';
  if (
    replay.degradedUs <= TRANSIENT_BUCKETS * t.bucketUs &&
    replay.incident.errorRate <= t.maxErrorRate
  )
    return 'resolves';
  const failed = d('requestsFailed');
  const degradedTime = d('degradedUs');
  const p99 = d('p99Us');
  if (failed === 'worse' || degradedTime === 'worse' || (p99 === 'worse' && failed !== 'better'))
    return 'worsens';
  if ((failed === 'better' || degradedTime === 'better') && p99 !== 'worse') return 'improves';
  return 'mixed';
}

// ---- side effects ---------------------------------------------------------------------------

const fmtState = (s: ResourceState): string =>
  `${s.status}${s.utilizationMean === null ? '' : `, utilization mean ${(100 * s.utilizationMean).toFixed(1)}%`}, queue mean ${s.queueMean.toFixed(1)}`;

/** The saturation analyzer on both runs, compared resource by resource (brief §7 side-effect panel). */
export function sideEffects(original: RunSummary, replay: RunSummary): SideEffect[] {
  const out: SideEffect[] = [];
  const before = new Map(original.saturation.map((r) => [r.resource, r]));
  for (const r of replay.saturation) {
    const o = before.get(r.resource) ?? null;
    const wasPressed = o !== null && PRESSURE.includes(o.status);
    const isPressed = PRESSURE.includes(r.status);
    if (isPressed && !wasPressed) {
      out.push({
        kind: 'new_bottleneck',
        subject: r.resource,
        message: `${r.resource} became a bottleneck: ${fmtState(r)} (original: ${o === null ? 'not seen' : fmtState(o)}).`,
        original: o,
        replay: r,
      });
    } else if (!isPressed && wasPressed) {
      out.push({
        kind: 'relieved',
        subject: r.resource,
        message: `${r.resource} is no longer a bottleneck: ${fmtState(r)} (original: ${fmtState(o)}).`,
        original: o,
        replay: r,
      });
    } else if (r.queueMean >= 1 && (o === null || o.queueMean < 1)) {
      out.push({
        kind: 'queue_formed',
        subject: r.resource,
        message: `A queue formed at ${r.resource}: ${fmtState(r)} (original: ${o === null ? 'not seen' : fmtState(o)}).`,
        original: o,
        replay: r,
      });
    }
  }
  const errorsBefore = new Map(original.failures.map((f) => [f.service, f.errors]));
  for (const f of replay.failures) {
    const o = errorsBefore.get(f.service) ?? 0;
    if (f.errors > o)
      out.push({
        kind: 'more_errors',
        subject: f.service,
        message: `${f.service} returned more errors: ${String(f.errors)} vs ${String(o)} in the original run.`,
        original: null,
        replay: null,
      });
  }
  return out;
}

// ---- the replayer ---------------------------------------------------------------------------

function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x !== null && typeof x === 'object')
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(x);
}

export const replayId = (incidentId: string, patches: readonly Patch[]): string =>
  `rp_${createHash('sha256').update(canonical({ incidentId, patches })).digest('hex').slice(0, 12)}`;

export interface ReplayerInput {
  incidentId: string;
  recording: Recording;
  /** The hash of the telemetry as recorded (and as stored). */
  telemetryHash: string;
}

/**
 * Holds one incident's recording and its identity replay; replays patches against it. Creating
 * one runs the identity replay and throws IdentityReplayError if it is not exact.
 */
export class Replayer {
  readonly incidentId: string;
  readonly recording: Recording;
  readonly windows: { baseline: Window; incident: Window };
  readonly thresholds: SymptomThresholds;
  readonly original: RunSummary;
  readonly identityHash: string;
  private readonly recordedHash: string;

  constructor(input: ReplayerInput) {
    this.incidentId = input.incidentId;
    this.recording = input.recording;
    this.recordedHash = input.telemetryHash;
    const result = runSimulation(input.recording.config, input.recording.workload);
    this.identityHash = hashTelemetry(result.telemetry);
    if (this.identityHash !== input.telemetryHash) {
      throw new IdentityReplayError(
        `identity replay is not exact: replaying the recording without patches gives telemetry ${this.identityHash.slice(0, 12)}, the recorded telemetry is ${input.telemetryHash.slice(0, 12)}. The simulator or the recording changed; no replay result can be trusted.`,
      );
    }
    const config = input.recording.config;
    const entryServices = [
      ...new Set(Object.values(config.model.requestTypes).map((r) => r.service)),
    ];
    const w = inferIncidentWindows(toSeries(result.telemetry.metrics), {
      range: { fromUs: 0, toUs: config.durationUs },
      entryServices,
    });
    if (w === null)
      throw new Error(
        `incident ${input.incidentId}: the recorded run shows no user-facing symptom`,
      );
    this.windows = { baseline: w.baseline, incident: w.incident };
    this.thresholds = symptomThresholds(
      result.outcomes,
      w.baseline,
      config.options.metricIntervalUs,
    );
    this.original = this.summarize(result, this.identityHash);
  }

  private summarize(result: SimResult, telemetryHash: string): RunSummary {
    return summarizeRun(result, {
      windows: this.windows,
      thresholds: this.thresholds,
      telemetryHash,
    });
  }

  /** Runs the patched recording. Throws (with the reason) when a patch does not apply. */
  replay(patches: readonly Patch[], source: ReplaySource = { kind: 'cli' }): ReplayRun {
    const config = applyPatches(this.recording.config, patches);
    const result = runSimulation(config, this.recording.workload);
    const replayHash = hashTelemetry(result.telemetry);
    const replay = this.summarize(result, replayHash);
    const headline = headlineDeltas(this.original, replay);
    return ReplayRun.parse({
      formatVersion: 1,
      kind: 'replay',
      id: replayId(this.incidentId, patches),
      notice: REPLAY_NOTICE,
      incidentId: this.incidentId,
      patches,
      source,
      pins: config.pins,
      identity: { recordedHash: this.recordedHash, replayedHash: this.identityHash, exact: true },
      windows: this.windows,
      thresholds: this.thresholds,
      original: this.original,
      replay,
      headline,
      verdict: verdictOf(headline, replay, this.thresholds),
      sideEffects: patches.length === 0 ? [] : sideEffects(this.original, replay),
      changeEvents: result.telemetry.changeEvents,
    });
  }

  /** Replays each recommendation of a diagnosis on its own. */
  replayRecommendations(
    recommendations: readonly Recommendation[],
    file: string,
  ): RecommendationComparison {
    const runs = recommendations.map((r) => {
      try {
        return {
          recommendation: r,
          run: this.replay([r.patch], {
            kind: 'diagnosis',
            file,
            recommendationId: r.id,
            addresses: r.addresses,
            title: r.title,
          }),
          reason: null,
        };
      } catch (e) {
        // A patch the model cannot simulate is reported, not fatal: the others still replay.
        if (!(e instanceof UnsupportedKnobError)) throw e;
        return { recommendation: r, run: null, reason: e.message };
      }
    });
    return compareRecommendations(runs);
  }

  /** Runs `[...base, param=v]` for every value (brief §7 sweep). */
  sweep(param: SetPatch['target'], values: readonly number[], base: readonly Patch[] = []): Sweep {
    const points: SweepPoint[] = values.map((value) => {
      const run = this.replay([...base, { target: param, to: value }], {
        kind: 'sweep',
        param,
      });
      const r = run.replay;
      return {
        value,
        verdict: run.verdict,
        errorRate: r.incident.errorRate,
        p50Us: r.incident.p50Us,
        p99Us: r.incident.p99Us,
        requestsFailed: r.incident.failed,
        degradedUs: r.degradedUs,
        acquireWaitUs: r.pool.totalAcquireWaitUs,
        dbQueueWaitUs: r.db.totalQueueWaitUs,
        underPressure: r.saturation
          .filter((s) => PRESSURE.includes(s.status))
          .map((s) => s.resource)
          .sort(),
      };
    });
    return Sweep.parse({
      formatVersion: 1,
      kind: 'sweep',
      notice: REPLAY_NOTICE,
      incidentId: this.incidentId,
      param,
      basePatches: base,
      windows: this.windows,
      original: {
        errorRate: this.original.incident.errorRate,
        p99Us: this.original.incident.p99Us,
        underPressure: this.original.saturation
          .filter((s) => PRESSURE.includes(s.status))
          .map((s) => s.resource)
          .sort(),
      },
      points,
      ...analyzeSweep(points, this.original),
    });
  }
}

// ---- recommendations: cause vs symptom ----------------------------------------------------------

export const RecommendationComparison = z.strictObject({
  notice: z.literal(REPLAY_NOTICE),
  rows: z.array(
    z.strictObject({
      recommendationId: z.string(),
      title: z.string(),
      addresses: z.enum(['cause', 'symptom']),
      patch: z.string(),
      verdict: z.union([Verdict, z.literal('not_replayable')]),
      newBottlenecks: z.array(z.string()),
      /** Null when the patch cannot be simulated; `reason` says why. */
      run: ReplayRun.nullable(),
      reason: z.string().nullable(),
    }),
  ),
  /** Deterministic summary of the comparison, built from the rows. */
  findings: z.array(z.string()),
});
export type RecommendationComparison = z.infer<typeof RecommendationComparison>;

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const dur = (us: number): string =>
  us >= 1_000_000 ? `${(us / 1_000_000).toFixed(2)} s` : `${(us / 1_000).toFixed(1)} ms`;

export function compareRecommendations(
  runs: readonly { recommendation: Recommendation; run: ReplayRun | null; reason: string | null }[],
): RecommendationComparison {
  const rows = runs.map(({ recommendation: r, run, reason }) => ({
    recommendationId: r.id,
    title: r.title,
    addresses: r.addresses,
    patch: formatPatch(r.patch),
    verdict: run === null ? ('not_replayable' as const) : run.verdict,
    newBottlenecks:
      run === null
        ? []
        : run.sideEffects
            .filter((s) => s.kind === 'new_bottleneck' || s.kind === 'queue_formed')
            .map((s) => s.subject),
    run,
    reason,
  }));
  const findings = rows.map((row) =>
    row.run === null
      ? `${row.recommendationId} (${row.addresses}, ${row.patch}): not replayable: ${row.reason ?? ''}.`
      : `${row.recommendationId} (${row.addresses}, ${row.patch}): ${row.verdict}; error rate ${pct(row.run.original.incident.errorRate)} → ${pct(row.run.replay.incident.errorRate)}, p99 ${dur(row.run.original.incident.p99Us)} → ${dur(row.run.replay.incident.p99Us)}${row.newBottlenecks.length === 0 ? '; no new bottleneck' : `; new pressure at ${row.newBottlenecks.join(', ')}`}.`,
  );
  const ran = rows.flatMap((r) => (r.run === null ? [] : [{ ...r, run: r.run }]));
  const ok = (v: string): boolean => v === 'resolves' || v === 'improves';
  const cause = ran.filter((r) => r.addresses === 'cause' && ok(r.verdict));
  const symptom = ran.filter((r) => r.addresses === 'symptom' && ok(r.verdict));
  for (const s of symptom) {
    for (const c of cause) {
      const sp = s.run.replay.incident.p99Us;
      const cp = c.run.replay.incident.p99Us;
      findings.push(
        `${s.recommendationId} treats the symptom and ${c.recommendationId} the cause: p99 ${dur(sp)} vs ${dur(cp)}${s.newBottlenecks.length > c.newBottlenecks.length ? `, and only ${s.recommendationId} moves pressure to ${s.newBottlenecks.join(', ')}` : ''}.`,
      );
    }
  }
  return RecommendationComparison.parse({ notice: REPLAY_NOTICE, rows, findings });
}

// ---- sweep ------------------------------------------------------------------------------------

export const SweepPoint = z.strictObject({
  value: z.number(),
  verdict: Verdict,
  errorRate: z.number(),
  p50Us: z.number(),
  p99Us: z.number(),
  requestsFailed: z.number(),
  degradedUs: z.number(),
  acquireWaitUs: z.number(),
  dbQueueWaitUs: z.number(),
  /** Resources the saturation analyzer finds saturated or busy in this run. */
  underPressure: z.array(z.string()),
});
export type SweepPoint = z.infer<typeof SweepPoint>;

export const Sweep = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal('sweep'),
  notice: z.literal(REPLAY_NOTICE),
  incidentId: z.string(),
  param: z.string(),
  basePatches: z.array(Patch),
  windows: z.strictObject({ baseline: WindowSchema, incident: WindowSchema }),
  original: z.strictObject({
    errorRate: z.number(),
    p99Us: z.number(),
    underPressure: z.array(z.string()),
  }),
  points: z.array(SweepPoint),
  /**
   * Smallest value at which the curve flattens: error rate within 0.5 points of the best in the
   * sweep and p99 within 10 % of the best p99 among those. Null if the curve never flattens.
   */
  knee: z.strictObject({ value: z.number(), reason: z.string() }).nullable(),
  /** Smallest value that resolves the incident (see the verdict rubric), or null. */
  resolvesFrom: z.number().nullable(),
  /** First value at which a resource that was not under pressure in the original run is. */
  bottleneckShift: z.strictObject({ value: z.number(), resources: z.array(z.string()) }).nullable(),
});
export type Sweep = z.infer<typeof Sweep>;

function analyzeSweep(
  points: readonly SweepPoint[],
  original: RunSummary,
): Pick<Sweep, 'knee' | 'resolvesFrom' | 'bottleneckShift'> {
  const sorted = [...points].sort((a, b) => a.value - b.value);
  let knee: Sweep['knee'] = null;
  if (sorted.length > 0) {
    const bestErr = Math.min(...sorted.map((p) => p.errorRate));
    const good = sorted.filter((p) => p.errorRate <= bestErr + 0.005);
    const bestP99 = Math.min(...good.map((p) => p.p99Us));
    const k = good.find((p) => p.p99Us <= 1.1 * bestP99);
    if (k !== undefined && k !== sorted.at(-1))
      knee = {
        value: k.value,
        reason: `from ${String(k.value)} on, error rate is within 0.5 points of the best in the sweep (${pct(bestErr)}) and p99 within 10% of the best (${dur(bestP99)}); larger values buy little more`,
      };
  }
  const pressedBefore = new Set(
    original.saturation.filter((s) => PRESSURE.includes(s.status)).map((s) => s.resource),
  );
  const shift = sorted.find((p) => p.underPressure.some((r) => !pressedBefore.has(r)));
  return {
    knee,
    resolvesFrom: sorted.find((p) => p.verdict === 'resolves')?.value ?? null,
    bottleneckShift:
      shift === undefined
        ? null
        : {
            value: shift.value,
            resources: shift.underPressure.filter((r) => !pressedBefore.has(r)),
          },
  };
}

/** Parses `from:to:step` (inclusive). */
export function parseRange(spec: string): number[] {
  const m = /^(\d+):(\d+):(\d+)$/.exec(spec.trim());
  if (m === null) throw new Error(`range must look like <from>:<to>:<step>, got "${spec}"`);
  const [from, to, step] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (step <= 0) throw new Error('range step must be positive');
  if (to < from) throw new Error('range end must not be below its start');
  const values: number[] = [];
  for (let v = from; v <= to; v += step) values.push(v);
  if (values.length > 50) throw new Error(`range has ${String(values.length)} values; at most 50`);
  return values;
}
