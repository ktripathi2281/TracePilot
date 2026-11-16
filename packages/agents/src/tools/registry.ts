// The data tools exposed to the LLM roles (brief §6). Thin wrappers over store + analysis: no
// tool computes anything the analysis library does not, and every number they return is in a
// finding with the evidence it came from.
//
// Each description documents the tool's FINDING KEYS and their possible values, because
// predictions are written against them.

import {
  METRIC_UNITS,
  MetricName,
  SPAN_ATTRS,
  type DerivedQuantity,
  type QuotedQuantity,
} from '@tracepilot/schema';
import {
  TIME_CATEGORIES,
  analyzeHoldAndWait,
  analyzePropagation,
  analyzeSaturation,
  attributeLatency,
  buildTimeline,
  compareSeries,
  criticalPath,
  dbQueryProfile,
  correlateChanges,
  durationUs,
  findSeries,
  inWindow,
  medianItems,
  quantile,
  spanEvidence,
  analyzeRetries,
  summarizePods,
  type TraceTree,
} from '@tracepilot/analysis';
import { z } from 'zod';
import { fmtDur, fmtMetric, fmtNum, fmtPct, fmtT } from '../format.ts';
import { WindowArg } from './context.ts';
import type { Finding, Row, ToolDef, ToolOutput } from './types.ts';

const d = (name: string, value: number, unit: string): DerivedQuantity => ({ name, value, unit });

/** Unit of a numeric value in a change-event diff: knobs named `...Us` are microseconds. */
export const diffUnit = (key: string): string => (/Us$/.test(key) ? 'us' : 'count');
const uniq = (ids: readonly string[], max = 6): string[] => [...new Set(ids)].slice(0, max);

/** Findings must cite evidence; one without any becomes a note instead of a fact. */
function output(summary: string, findings: Finding[], extra: Partial<ToolOutput> = {}): ToolOutput {
  const notes = [...(extra.notes ?? [])];
  const kept: Finding[] = [];
  for (const f of findings) {
    if (f.evidenceIds.length > 0) kept.push(f);
    else notes.push(`(not citable, no evidence items) ${f.statement}`);
  }
  const out: ToolOutput = { summary, findings: kept };
  if (extra.rows !== undefined) out.rows = extra.rows;
  if (notes.length > 0) out.notes = notes;
  return out;
}

const windowWords = (label: string): string =>
  label === 'baseline' || label === 'incident' ? `the ${label} window` : `window ${label}`;

// ---- 1. get_incident_window ------------------------------------------------------------------

const getIncidentWindow: ToolDef = {
  name: 'get_incident_window',
  description: `Where the user-facing symptom is and which time windows to compare. No arguments.
Findings:
- \`symptom\`: value "<service>/<metric>" of the earliest ongoing error-rate or p99 anomaly at an entry service, with its onset; value "none" if there is no symptom.
- \`window.baseline\`, \`window.incident\`: value "T+a – T+b". Other tools accept window: "baseline" | "incident".
- \`entry_services\`: value is the comma-separated services that own root spans.`,
  input: z.strictObject({}),
  run: (ctx) => {
    const w = ctx.inferred;
    const { baseline, incident } = ctx.windows;
    const anchor =
      w?.symptom.evidenceIds ??
      ctx.series
        .find((s) => ctx.graph.entryServices.includes(s.service))
        ?.points.slice(0, 1)
        .map((p) => p.evidenceId) ??
      [];
    const findings: Finding[] = [
      w === null
        ? {
            key: 'symptom',
            statement: 'No persistent error-rate or p99 anomaly was found at any entry service.',
            value: 'none',
            evidenceIds: anchor,
            quantities: [],
            derived: [],
          }
        : {
            key: 'symptom',
            statement: `User-facing symptom: ${w.symptom.service} ${w.symptom.metric} anomalous from ${fmtT(w.symptom.onsetUs)} (${w.symptom.status}).`,
            value: `${w.symptom.service}/${w.symptom.metric}`,
            evidenceIds: uniq(w.symptom.evidenceIds, 3),
            quantities: [],
            derived: [d('onsetUs', w.symptom.onsetUs, 'us')],
            occurredAt: { tsUs: w.symptom.onsetUs, resolutionUs: w.symptom.onsetResolutionUs },
          },
      {
        key: 'window.baseline',
        statement: `Baseline window: ${fmtT(baseline.fromUs)} – ${fmtT(baseline.toUs)}.`,
        value: `${fmtT(baseline.fromUs)} – ${fmtT(baseline.toUs)}`,
        evidenceIds: uniq(anchor, 1),
        quantities: [],
        derived: [d('fromUs', baseline.fromUs, 'us'), d('toUs', baseline.toUs, 'us')],
      },
      {
        key: 'window.incident',
        statement: `Incident window: ${fmtT(incident.fromUs)} – ${fmtT(incident.toUs - 1)} (end of data).`,
        value: `${fmtT(incident.fromUs)} – ${fmtT(incident.toUs - 1)}`,
        evidenceIds: uniq(anchor, 1),
        quantities: [],
        derived: [d('fromUs', incident.fromUs, 'us'), d('toUs', incident.toUs, 'us')],
      },
      {
        key: 'entry_services',
        statement: `Requests enter the system at: ${ctx.graph.entryServices.join(', ')}.`,
        value: ctx.graph.entryServices.join(','),
        evidenceIds: uniq(anchor, 1),
        quantities: [],
        derived: [],
      },
    ];
    return output(
      `Incident ${ctx.incidentId}: ${String(ctx.incident.services.length)} services (${ctx.incident.services.join(', ')}), telemetry ${fmtT(ctx.incident.startUs)} – ${fmtT(ctx.incident.endUs)}, metric interval ${fmtDur(ctx.tick)}.`,
      findings,
    );
  },
};

// ---- 2. list_change_events -------------------------------------------------------------------

const listChangeEvents: ToolDef = {
  name: 'list_change_events',
  description: `All deploy/config/rollout events in the telemetry, with their diffs. No arguments.
Findings: \`change.<id>\`: value is the kind (deploy|config|rollout); the statement has the description and diff; dated at the event time.`,
  input: z.strictObject({}),
  run: (ctx) => {
    const findings: Finding[] = ctx.changes.map((c) => {
      const quantities: QuotedQuantity[] = [
        { evidenceId: c.id, field: 'ts', value: c.ts, unit: 'us' },
      ];
      const parts: string[] = [];
      for (const [key, v] of Object.entries(c.diff)) {
        parts.push(`${key} ${String(v.from)} → ${String(v.to)}`);
        if (typeof v.from === 'number')
          quantities.push({
            evidenceId: c.id,
            field: `diff.${key}.from`,
            value: v.from,
            unit: diffUnit(key),
          });
        if (typeof v.to === 'number')
          quantities.push({
            evidenceId: c.id,
            field: `diff.${key}.to`,
            value: v.to,
            unit: diffUnit(key),
          });
      }
      return {
        key: `change.${c.id}`,
        statement: `${c.id}: ${c.kind} on ${c.service} at ${fmtT(c.ts)}: "${c.description}"${parts.length > 0 ? `; diff: ${parts.join(', ')}` : ''}.`,
        value: c.kind,
        evidenceIds: [c.id],
        quantities,
        derived: [],
        occurredAt: { tsUs: c.ts, resolutionUs: 1 },
      };
    });
    return output(`${String(ctx.changes.length)} change event(s).`, findings);
  },
};

// ---- 3. get_metric_series --------------------------------------------------------------------

const GetMetricSeries = z.strictObject({
  service: z.string().min(1),
  metric: MetricName,
  window: WindowArg.optional(),
});
const getMetricSeries: ToolDef<typeof GetMetricSeries> = {
  name: 'get_metric_series',
  description: `One metric series (5 s samples). Arguments: service, metric, window (default: whole telemetry range). Services include "db" for pool_in_use, pool_capacity, pool_wait_queue, db_active_queries, query_exec_p95, queue_depth (DB executor queue).
Findings: \`series.<service>.<metric>.<window>.median\` and \`.max\` (value is the number). Rows: up to 16 evenly spaced samples.`,
  input: GetMetricSeries,
  run: (ctx, args) => {
    const s = findSeries(ctx.series, args.service, args.metric);
    if (s === undefined) return output(`No series ${args.service}/${args.metric}.`, []);
    const w =
      args.window === undefined
        ? { window: { fromUs: 0, toUs: Number.MAX_SAFE_INTEGER }, label: 'all' }
        : ctx.resolveWindow(args.window);
    const pts = s.points.filter((p) => inWindow(p.ts, w.window));
    if (pts.length === 0)
      return output(`No samples of ${args.service}/${args.metric} in ${windowWords(w.label)}.`, []);
    const unit = METRIC_UNITS[args.metric];
    const med = quantile(
      pts.map((p) => p.value),
      0.5,
    );
    const max = pts.reduce((a, b) => (b.value > a.value ? b : a));
    const prefix = `series.${args.service}.${args.metric}.${w.label}`;
    const step = Math.max(1, Math.ceil(pts.length / 16));
    const rows: Row[] = pts
      .filter((_, i) => i % step === 0)
      .map((p) => ({ t: fmtT(p.ts), value: p.value, evidence: p.evidenceId }));
    return output(
      `${args.service} ${args.metric} in ${windowWords(w.label)}: ${String(pts.length)} samples.`,
      [
        {
          key: `${prefix}.median`,
          statement: `${args.service} ${args.metric} median in ${windowWords(w.label)}: ${fmtMetric(med, unit)} (${String(pts.length)} samples).`,
          value: Math.round(med * 1000) / 1000,
          evidenceIds: medianItems(pts, (p) => p.value).map((p) => p.evidenceId),
          quantities: [],
          derived: [d('median', med, unit), d('samples', pts.length, 'count')],
        },
        {
          key: `${prefix}.max`,
          statement: `${args.service} ${args.metric} maximum in ${windowWords(w.label)}: ${fmtMetric(max.value, unit)} at ${fmtT(max.ts)}.`,
          value: max.value,
          evidenceIds: [max.evidenceId],
          quantities: [{ evidenceId: max.evidenceId, field: 'value', value: max.value, unit }],
          derived: [],
        },
      ],
      { rows },
    );
  },
};

// ---- 4. detect_anomalies ---------------------------------------------------------------------

const DetectAnomalies = z.strictObject({
  service: z.string().min(1).optional(),
  status: z.enum(['ongoing', 'recovered']).optional(),
});
const detectAnomaliesTool: ToolDef<typeof DetectAnomalies> = {
  name: 'detect_anomalies',
  description: `Persistent metric anomalies against the baseline (single-sample spikes are never flagged). Arguments: service (optional), status (optional: ongoing | recovered).
Findings: \`anomaly.<service>.<metric>.<onsetUs>\`: value "<up|down>/<ongoing|recovered>", dated at its onset (resolution = metric interval or wider). "recovered" anomalies ended before the end of the data.`,
  input: DetectAnomalies,
  run: (ctx, args) => {
    const list = ctx.anomalies.anomalies.filter(
      (a) =>
        (args.service === undefined || a.service === args.service) &&
        (args.status === undefined || a.status === args.status),
    );
    const findings: Finding[] = list.map((a) => ({
      key: `anomaly.${a.service}.${a.metric}.${String(a.onsetUs)}`,
      statement: `${a.service} ${a.metric} ${a.direction} from ${fmtT(a.onsetUs)}: baseline median ${fmtMetric(a.baseline.median, a.unit)} → ${fmtMetric(a.value.median, a.unit)}; ${a.status === 'ongoing' ? 'ongoing at end of data' : `recovered at ${fmtT(a.endUs ?? 0)}`}.`,
      value: `${a.direction}/${a.status}`,
      evidenceIds: uniq(a.evidenceIds, 4),
      quantities: [],
      derived: [
        d('baselineMedian', a.baseline.median, a.unit),
        d('anomalyMedian', a.value.median, a.unit),
        d('onsetUs', a.onsetUs, 'us'),
        ...(a.endUs === null ? [] : [d('endUs', a.endUs, 'us')]),
      ],
      occurredAt: { tsUs: a.onsetUs, resolutionUs: a.onsetResolutionUs },
    }));
    const ongoing = list.filter((a) => a.status === 'ongoing').length;
    return output(
      `${String(list.length)} anomalies (${String(ongoing)} ongoing, ${String(list.length - ongoing)} recovered).`,
      findings,
    );
  },
};

// ---- 5. build_timeline -----------------------------------------------------------------------

const BuildTimeline = z.strictObject({
  fromUs: z.number().int().nonnegative().optional(),
  toUs: z.number().int().positive().optional(),
});
const buildTimelineTool: ToolDef<typeof BuildTimeline> = {
  name: 'build_timeline',
  description: `One ordered timeline of change events, span-level onsets (exact times from sampled spans), metric anomaly onsets and recoveries, and error-log bursts. Arguments: fromUs, toUs (optional).
Findings: \`timeline.<kind>.<service>.<tsUs>[.n]\`, kind ∈ change | span_onset | anomaly_onset | log_burst | anomaly_recovered; value is the kind; each is dated. Anomalies of one service at one time are grouped.`,
  input: BuildTimeline,
  run: (ctx, args) => {
    const from = args.fromUs ?? 0;
    const to = args.toUs ?? Number.MAX_SAFE_INTEGER;
    const entries = buildTimeline({
      changes: ctx.changes,
      anomalies: ctx.anomalies.anomalies,
      logBursts: ctx.logBursts,
      spanOnsets: Object.values(ctx.refined.onsets),
    }).filter((e) => e.ts >= from && e.ts < to);
    // Group anomaly entries by (time, service, kind, status).
    interface Group {
      ts: number;
      kind: string;
      service: string;
      status: string | undefined;
      parts: string[];
      evidence: string[];
    }
    const groups: Group[] = [];
    const byKey = new Map<string, Group>();
    for (const e of entries) {
      const isAnomaly = e.kind === 'anomaly_onset' || e.kind === 'anomaly_recovered';
      const gk = isAnomaly ? `${String(e.ts)}|${e.kind}|${e.service}|${e.status ?? ''}` : '';
      const existing = isAnomaly ? byKey.get(gk) : undefined;
      const part =
        e.kind === 'anomaly_recovered' ? (e.summary.split(' ')[0] ?? e.summary) : e.summary;
      if (existing !== undefined) {
        existing.parts.push(part);
        existing.evidence.push(...e.evidenceIds.slice(0, 1));
        continue;
      }
      const g: Group = {
        ts: e.ts,
        kind: e.kind,
        service: e.service,
        status: e.status,
        parts: [part],
        evidence: e.evidenceIds.slice(0, isAnomaly ? 1 : 3),
      };
      groups.push(g);
      if (isAnomaly) byKey.set(gk, g);
    }
    const seen = new Map<string, number>();
    const findings: Finding[] = groups.map((g) => {
      const baseKey = `timeline.${g.kind}.${g.service}.${String(g.ts)}`;
      const n = seen.get(baseKey) ?? 0;
      seen.set(baseKey, n + 1);
      const what =
        g.kind === 'anomaly_recovered'
          ? `back within baseline: ${g.parts.join(', ')}`
          : g.kind === 'anomaly_onset'
            ? `anomaly onset (${g.status ?? ''}): ${g.parts.join('; ')}`
            : g.kind === 'log_burst'
              ? `log burst (${g.status === 'ongoing' ? 'ongoing' : 'ended'}): ${g.parts.join('; ')}`
              : g.parts.join('; ');
      return {
        key: n === 0 ? baseKey : `${baseKey}.${String(n)}`,
        statement: `${fmtT(g.ts)} ${g.service}: ${what}.`,
        value: g.kind,
        evidenceIds: uniq(g.evidence, 4),
        quantities: [],
        derived: [d('tsUs', g.ts, 'us')],
        occurredAt: {
          tsUs: g.ts,
          resolutionUs: g.kind === 'anomaly_onset' || g.kind === 'anomaly_recovered' ? ctx.tick : 1,
        },
      };
    });
    return output(`${String(findings.length)} timeline entries.`, findings);
  },
};

// ---- 6. get_dependency_graph -----------------------------------------------------------------

const getDependencyGraph: ToolDef = {
  name: 'get_dependency_graph',
  description: `Who calls whom, derived from sampled spans (counts are sampled counts). No arguments.
Findings: \`graph.edge.<from>.<to>\`: value is the edge kind (call | database | external).`,
  input: z.strictObject({}),
  run: (ctx) => {
    const g = ctx.graph;
    const findings: Finding[] = g.edges.map((e) => ({
      key: `graph.edge.${e.from}.${e.to}`,
      statement: `${e.from} → ${e.to} (${e.kind}, from operations: ${e.callerOperations.join(', ')}): ${String(e.callCount)} sampled calls, ${String(e.errorCount)} failed, p50 ${fmtDur(e.latencyP50Us)}, p95 ${fmtDur(e.latencyP95Us)} over the whole range.`,
      value: e.kind,
      evidenceIds: uniq(e.evidenceIds, 3),
      quantities: [],
      derived: [
        d('callCount', e.callCount, 'count'),
        d('errorCount', e.errorCount, 'count'),
        d('latencyP50Us', e.latencyP50Us, 'us'),
        d('latencyP95Us', e.latencyP95Us, 'us'),
      ],
    }));
    return output(
      `Entry services: ${g.entryServices.join(', ')}. ${String(g.edges.length)} edges among ${g.nodes.map((n) => `${n.service} (${n.kind})`).join(', ')}.`,
      findings,
    );
  },
};

// ---- 7. attribute_latency --------------------------------------------------------------------

const AttributeLatency = z.strictObject({ window: WindowArg, route: z.string().min(1).optional() });
const attributeLatencyTool: ToolDef<typeof AttributeLatency> = {
  name: 'attribute_latency',
  description: `Where request time went, by critical path, separately for successful and failed requests. Arguments: window, route (optional: root operation name, e.g. the entry service's operation; default all routes).
Exclusive categories: queue_wait (waiting for a worker), pool_acquire (waiting for a DB connection), db_queue (queued at the DB executor), query_exec (DB executing), external, compute.
Findings (route = the route argument or "all"):
- \`attribution.<window>.<route>.<success|failure>.dominant\`: value is the category with the largest share.
- \`attribution.<window>.<route>.<success|failure>.held\`: value is what the request was mostly doing WHILE it held a DB connection inside a transaction (same categories, or "none").`,
  input: AttributeLatency,
  run: (ctx, args) => {
    const w = ctx.resolveWindow(args.window);
    const route = args.route ?? 'all';
    const result = attributeLatency(ctx.tracesIn(w, args.route));
    const findings: Finding[] = [];
    for (const g of result.groups) {
      const prefix = `attribution.${w.label}.${route}.${g.outcome}`;
      const shares = TIME_CATEGORIES.filter((c) => g.shares[c] >= 0.0005)
        .sort((a, b) => g.shares[b] - g.shares[a])
        .map((c) => `${c} ${fmtPct(g.shares[c])}`)
        .join(', ');
      findings.push({
        key: `${prefix}.dominant`,
        statement: `${g.outcome === 'success' ? 'Successful' : 'Failed'} requests (route ${route}, ${windowWords(w.label)}, ${String(g.traces)} sampled traces, p50 ${fmtDur(g.latencyUs.p50)}, p99 ${fmtDur(g.latencyUs.p99)}): time went to ${shares}.`,
        value: g.dominant,
        evidenceIds: uniq(g.evidenceIds, 5),
        quantities: [],
        derived: [
          d('traces', g.traces, 'count'),
          d('p50Us', g.latencyUs.p50, 'us'),
          d('p99Us', g.latencyUs.p99, 'us'),
          ...TIME_CATEGORIES.map((c) => d(`share.${c}`, g.shares[c], 'ratio')),
        ],
      });
      const held = g.heldConnection;
      const heldDominant =
        held.totalUs === 0
          ? 'none'
          : TIME_CATEGORIES.reduce(
              (best, c) => (held.byCategory[c] > held.byCategory[best] ? c : best),
              'compute' as (typeof TIME_CATEGORIES)[number],
            );
      const heldShares =
        held.totalUs === 0
          ? ''
          : TIME_CATEGORIES.filter((c) => held.byCategory[c] / held.totalUs >= 0.0005)
              .sort((a, b) => held.byCategory[b] - held.byCategory[a])
              .map((c) => `${c} ${fmtPct(held.byCategory[c] / held.totalUs)}`)
              .join(', ');
      findings.push({
        key: `${prefix}.held`,
        statement:
          held.totalUs === 0
            ? `${g.outcome === 'success' ? 'Successful' : 'Failed'} requests (route ${route}, ${windowWords(w.label)}) never held a DB connection inside a transaction on their critical path.`
            : `${g.outcome === 'success' ? 'Successful' : 'Failed'} requests (route ${route}, ${windowWords(w.label)}) held a DB connection in a transaction for ${fmtPct(held.share)} of their time; while holding it they were: ${heldShares}.`,
        value: heldDominant,
        evidenceIds: uniq(g.evidenceIds, 5),
        quantities: [],
        derived: [
          d('heldShare', held.share, 'ratio'),
          ...(held.totalUs === 0
            ? []
            : TIME_CATEGORIES.map((c) =>
                d(`heldShare.${c}`, held.byCategory[c] / held.totalUs, 'ratio'),
              )),
        ],
      });
    }
    return output(
      `${String(result.traces)} sampled traces attributed in ${windowWords(w.label)} (route ${route}).`,
      findings,
    );
  },
};

// ---- 8. get_saturation -----------------------------------------------------------------------

const WindowOnly = z.strictObject({ window: WindowArg });
const getSaturation: ToolDef<typeof WindowOnly> = {
  name: 'get_saturation',
  description: `USE method per resource in a window: utilization, queue (saturation), errors. Argument: window.
Resources: "db.pool" (connection pool), "db.executor" (DB query executor), "<service>.workers".
Findings: \`saturation.<resource>.<window>.status\`: value saturated (≥95 % utilized with a queue, for ≥3 consecutive samples) | busy (≥95 % utilized, no queue) | ok | unknown-capacity (limit not observable and never queued). The statement gives utilization, queue and the share of the window spent saturated.`,
  input: WindowOnly,
  run: (ctx, args) => {
    const w = ctx.resolveWindow(args.window);
    const res = analyzeSaturation(ctx.metrics, ctx.spans, {
      baseline: ctx.windows.baseline,
      window: w.window,
    });
    const findings: Finding[] = res.map((r) => ({
      key: `saturation.${r.resource}.${w.label}.status`,
      statement: `${r.resource} in ${windowWords(w.label)}: ${r.status}; capacity ${r.capacity.value === null ? 'unknown' : `${fmtNum(r.capacity.value)} (${r.capacity.source})`}; utilization ${r.utilization === null ? 'n/a' : `mean ${fmtPct(r.utilization.mean)}`}; queue mean ${fmtNum(r.saturation.mean)}, max ${fmtNum(r.saturation.max)}; saturated for ${fmtPct(r.saturatedShare)} of the window${r.saturatedFromUs === null ? '' : `, from ${fmtT(r.saturatedFromUs)}`}${r.errors.count === null ? '' : `; ${String(r.errors.count)} sampled acquire timeouts`}.`,
      value: r.status,
      evidenceIds: uniq(r.evidenceIds, 5),
      quantities: [],
      derived: [
        ...(r.capacity.value === null ? [] : [d('capacity', r.capacity.value, 'count')]),
        ...(r.utilization === null ? [] : [d('utilizationMean', r.utilization.mean, 'ratio')]),
        d('queueMean', r.saturation.mean, 'count'),
        d('queueMax', r.saturation.max, 'count'),
        d('saturatedShare', r.saturatedShare, 'ratio'),
      ],
      ...(r.saturatedFromUs === null
        ? {}
        : { occurredAt: { tsUs: r.saturatedFromUs, resolutionUs: ctx.tick } }),
    }));
    const flagged = res.filter((r) => r.status === 'saturated').map((r) => r.resource);
    return output(
      `Saturated in ${windowWords(w.label)}: ${flagged.length === 0 ? 'nothing' : flagged.join(', ')}.`,
      findings,
    );
  },
};

// ---- get_retry_stats --------------------------------------------------------------------------

const getRetryStats: ToolDef<typeof WindowOnly> = {
  name: 'get_retry_stats',
  description: `Per service, how many of the requests it received in a window were retries by its callers (sampled server spans with retry.attempt > 1). Argument: window.
Findings: \`retries.<service>.<window>.amplified\`: true when at least 5 % of its requests were retries (callers are multiplying its load) | false. The statement gives requests, retries, their share and the amplification (requests / first attempts).`,
  input: WindowOnly,
  run: (ctx, args) => {
    const w = ctx.resolveWindow(args.window);
    const stats = analyzeRetries(ctx.spans, w.window);
    const findings: Finding[] = stats.map((r) => ({
      key: `retries.${r.service}.${w.label}.amplified`,
      statement: `${r.service} in ${windowWords(w.label)}: ${String(r.retries)} of ${String(r.requests)} sampled requests were retries (${fmtPct(r.share)}; amplification ${fmtNum(r.amplification)}).`,
      value: r.share >= 0.05,
      evidenceIds: r.evidenceIds,
      quantities: [],
      derived: [
        d('requests', r.requests, 'count'),
        d('retries', r.retries, 'count'),
        d('retryShare', r.share, 'ratio'),
        d('amplification', r.amplification, 'value'),
      ],
    }));
    const amplified = stats.filter((r) => r.share >= 0.05).map((r) => r.service);
    return output(
      `Retried in ${windowWords(w.label)}: ${amplified.length === 0 ? 'no service above 5 %' : amplified.join(', ')}.`,
      findings,
    );
  },
};

// ---- get_pod_events ---------------------------------------------------------------------------

const getPodEvents: ToolDef<typeof WindowOnly> = {
  name: 'get_pod_events',
  description: `Kubernetes-style pod lifecycle per service in a window: OOMKilled, CrashLoopBackOff, Restarted, Evicted, ReadinessFailed events, from pod events and the replicas_ready metric. Argument: window.
Findings: \`pods.<service>.<window>.oom_killed\` (true | false; dated at the first OOMKilled), \`pods.<service>.<window>.crash_loop\` (true | false), \`pods.<service>.<window>.disrupted\` (true | false: any pod taken out of service; dated at the first). Services without pod events get false findings only if they report replicas_ready.`,
  input: WindowOnly,
  run: (ctx, args) => {
    const w = ctx.resolveWindow(args.window);
    const summaries = summarizePods(ctx.podEvents, w.window);
    const findings: Finding[] = [];
    for (const p of summaries) {
      const base = `pods.${p.service}.${w.label}`;
      const counts = `${String(p.oomKilled)} OOMKilled, ${String(p.crashLoopBackOff)} CrashLoopBackOff, ${String(p.restarted)} restarts, ${String(p.evicted)} evicted, ${String(p.readinessFailed)} readiness failures across ${p.pods.join(', ')}`;
      const derived = [
        d('oomKilled', p.oomKilled, 'count'),
        d('crashLoopBackOff', p.crashLoopBackOff, 'count'),
        d('restarted', p.restarted, 'count'),
        d('podsAffected', p.pods.length, 'count'),
      ];
      const first = p.firstOomKilled;
      findings.push({
        key: `${base}.oom_killed`,
        statement: `${p.service} pods in ${windowWords(w.label)}: ${counts}.${first === null ? '' : ` First OOMKilled at ${fmtT(first.ts)}.`}`,
        value: p.oomKilled > 0,
        evidenceIds: p.evidenceIds,
        quantities:
          first === null
            ? []
            : [{ evidenceId: first.evidenceId, field: 'ts', value: first.ts, unit: 'us' }],
        derived,
        ...(first === null ? {} : { occurredAt: { tsUs: first.ts, resolutionUs: 1 } }),
      });
      findings.push({
        key: `${base}.crash_loop`,
        statement: `${p.service} pods in ${windowWords(w.label)}: ${String(p.crashLoopBackOff)} CrashLoopBackOff events (restart back-off after repeated failures).`,
        value: p.crashLoopBackOff > 0,
        evidenceIds: p.evidenceIds,
        quantities: [],
        derived: [d('crashLoopBackOff', p.crashLoopBackOff, 'count')],
      });
      const dis = p.firstDisruption;
      findings.push({
        key: `${base}.disrupted`,
        statement: `${p.service} pods in ${windowWords(w.label)}: ${dis === null ? 'no pod was taken out of service' : `first taken out of service at ${fmtT(dis.ts)} (${dis.reason})`}.`,
        value: dis !== null,
        evidenceIds: p.evidenceIds,
        quantities:
          dis === null
            ? []
            : [{ evidenceId: dis.evidenceId, field: 'ts', value: dis.ts, unit: 'us' }],
        derived: [],
        ...(dis === null ? {} : { occurredAt: { tsUs: dis.ts, resolutionUs: 1 } }),
      });
    }
    // Services that run pods (they report replicas_ready) but had no events: explicit "false".
    const withEvents = new Set(summaries.map((p) => p.service));
    for (const s of ctx.series.filter(
      (x) => x.name === 'replicas_ready' && !withEvents.has(x.service),
    )) {
      const pts = s.points.filter((pt) => inWindow(pt.ts, w.window));
      const firstPoint = pts[0];
      if (firstPoint === undefined) continue;
      const evidence = uniq(
        [
          firstPoint.evidenceId,
          ...(pts.at(-1) === undefined ? [] : [pts.at(-1)?.evidenceId ?? '']),
        ].filter((x) => x !== ''),
      );
      const statement = `${s.service} pods in ${windowWords(w.label)}: no pod events; replicas_ready stayed between ${fmtNum(Math.min(...pts.map((pt) => pt.value)))} and ${fmtNum(Math.max(...pts.map((pt) => pt.value)))}.`;
      for (const k of ['oom_killed', 'crash_loop', 'disrupted'])
        findings.push({
          key: `pods.${s.service}.${w.label}.${k}`,
          statement,
          value: false,
          evidenceIds: evidence,
          quantities: [],
          derived: [],
        });
    }
    const hit = summaries.filter((p) => p.oomKilled > 0).map((p) => p.service);
    return output(
      findings.length === 0
        ? `No pod events and no pod metrics in ${windowWords(w.label)}.`
        : `OOMKilled pods in ${windowWords(w.label)}: ${hit.length === 0 ? 'none' : hit.join(', ')}.`,
      findings,
    );
  },
};

// ---- 9. analyze_propagation ------------------------------------------------------------------

const analyzePropagationTool: ToolDef = {
  name: 'analyze_propagation',
  description: `Orders when each node of the dependency graph became anomalous and walks failure paths from the entry service down to where they end. Uses span-refined onsets (exact) where available, else metric onsets (one-tick resolution). Onsets closer than the coarser resolution are NOT ordered. No arguments.
Findings:
- \`propagation.origin\`: value is the comma-separated node(s) where failure paths end (candidate origins), or "none".
- \`propagation.onset.<node>\`: value span | metric (basis); dated.
- \`propagation.edge.<caller>.<callee>\`: value callee_first (consistent with failure propagating upward) | caller_first | inconclusive.
- \`propagation.excluded.<service>.<metric>.<onsetUs>\`: value recovered_before_incident (an earlier episode that is not part of this incident) | less_work (the node received less work, e.g. request rate down: a consequence of its callers failing, not a failure of its own).`,
  input: z.strictObject({}),
  run: (ctx) => {
    const anomalies = ctx.anomalies.anomalies;
    const p = analyzePropagation(ctx.graph, anomalies, {
      incident: ctx.windows.incident,
      refinedOnsets: ctx.refined.onsets,
      refinedByOperation: ctx.refined.byOperation,
    });
    const onsetOf = new Map(p.onsets.map((o) => [o.service, o]));
    const findings: Finding[] = [];
    const first = p.origins[0];
    findings.push({
      key: 'propagation.origin',
      statement:
        p.origins.length === 0
          ? 'No failure path was found.'
          : `Failure paths from the entry service end at: ${p.origins.map((o) => `${o.service} (onset ${fmtT(o.onset.ts)}, ${String(o.consistentPaths)}/${String(o.paths)} paths without a precedence violation)`).join('; ')}.`,
      value: p.origins.length === 0 ? 'none' : p.origins.map((o) => o.service).join(','),
      evidenceIds: uniq(
        p.origins.flatMap((o) => o.onset.evidenceIds),
        4,
      ),
      quantities: [],
      derived: p.origins.flatMap((o) => [
        d(`onsetUs.${o.service}`, o.onset.ts, 'us'),
        d(`paths.${o.service}`, o.paths, 'count'),
        d(`consistentPaths.${o.service}`, o.consistentPaths, 'count'),
      ]),
      ...(first === undefined
        ? {}
        : { occurredAt: { tsUs: first.onset.ts, resolutionUs: first.onset.resolutionUs } }),
    });
    for (const o of p.onsets) {
      findings.push({
        key: `propagation.onset.${o.service}`,
        statement: `${o.service} became anomalous by ${fmtT(o.onset.ts)} (resolution ${fmtDur(o.onset.resolutionUs)}, from ${o.onset.basis}s: ${o.onset.label}).`,
        value: o.onset.basis,
        evidenceIds: uniq(o.onset.evidenceIds, 3),
        quantities: [],
        derived: [d('onsetUs', o.onset.ts, 'us'), d('resolutionUs', o.onset.resolutionUs, 'us')],
        occurredAt: { tsUs: o.onset.ts, resolutionUs: o.onset.resolutionUs },
      });
    }
    for (const e of p.edges) {
      const verdict =
        e.precedence.verdict === 'a_before_b'
          ? 'callee_first'
          : e.precedence.verdict === 'b_before_a'
            ? 'caller_first'
            : 'inconclusive';
      findings.push({
        key: `propagation.edge.${e.caller}.${e.callee}`,
        statement: `${e.caller} → ${e.callee}: ${verdict} (${e.precedence.reason}).`,
        value: verdict,
        evidenceIds: uniq(
          [
            ...(onsetOf.get(e.callee)?.onset.evidenceIds ?? []),
            ...(onsetOf.get(e.caller)?.onset.evidenceIds ?? []),
          ],
          4,
        ),
        quantities: [],
        derived: [
          d('deltaUs', e.precedence.deltaUs, 'us'),
          d('resolutionUs', e.precedence.resolutionUs, 'us'),
        ],
      });
    }
    for (const x of p.excluded) {
      const a = anomalies.find(
        (y) => y.service === x.service && y.metric === x.metric && y.onsetUs === x.onsetUs,
      );
      findings.push({
        key: `propagation.excluded.${x.service}.${x.metric}.${String(x.onsetUs)}`,
        statement:
          x.kind === 'recovered_before_incident'
            ? `${x.service} ${x.metric} anomaly from ${fmtT(x.onsetUs)} is not part of this incident: it recovered at ${fmtT(x.endUs ?? 0)}, before the incident window.`
            : `${x.service} ${x.metric} anomaly from ${fmtT(x.onsetUs)} is not counted as ${x.service} failing: ${x.reason}.`,
        value: x.kind,
        evidenceIds: uniq(a?.evidenceIds ?? [], 3),
        quantities: [],
        derived: [
          d('onsetUs', x.onsetUs, 'us'),
          ...(x.endUs === null ? [] : [d('endUs', x.endUs, 'us')]),
        ],
        occurredAt: { tsUs: x.onsetUs, resolutionUs: a?.onsetResolutionUs ?? ctx.tick },
      });
    }
    return output(
      `${String(p.paths.length)} failure path(s): ${p.paths.map((x) => x.nodes.join(' → ')).join('; ') || 'none'}.`,
      findings,
    );
  },
};

// ---- 10. search_logs -------------------------------------------------------------------------

const SearchLogs = z.strictObject({
  service: z.string().min(1).optional(),
  levels: z
    .array(z.enum(['debug', 'info', 'warn', 'error']))
    .min(1)
    .optional(),
  contains: z.string().min(1).optional(),
  window: WindowArg.optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
const searchLogs: ToolDef<typeof SearchLogs> = {
  name: 'search_logs',
  description: `Search logs. Request logs are trace-sampled (about 1 in 20), so counts are sampled counts. Arguments: service, levels, contains (case-insensitive substring), window, limit (max 20, default 8).
Findings: \`logs.match\`: value is the number of matching sampled log records; dated at the first match. Rows: the first matches.`,
  input: SearchLogs,
  run: (ctx, args) => {
    const w = args.window === undefined ? undefined : ctx.resolveWindow(args.window);
    const all = ctx.store.searchLogs(ctx.incidentId, {
      service: args.service,
      levels: args.levels,
      contains: args.contains,
      ...(w === undefined ? {} : w.window),
    });
    const shown = all.slice(0, args.limit ?? 8);
    const rows: Row[] = shown.map((l) => ({
      t: fmtT(l.ts),
      service: l.service,
      level: l.level,
      message: l.message,
      evidence: l.id,
    }));
    const filter = [
      args.service,
      args.levels?.join('|'),
      args.contains === undefined ? undefined : `"${args.contains}"`,
      w?.label,
    ]
      .filter((x) => x !== undefined)
      .join(', ');
    const firstLog = all[0];
    const lastLog = all.at(-1);
    if (firstLog === undefined || lastLog === undefined)
      return output(`No log records match (${filter}).`, [], { rows });
    return output(
      `${String(all.length)} matching sampled log records (${filter}).`,
      [
        {
          key: 'logs.match',
          statement: `${String(all.length)} sampled log records match (${filter}), first at ${fmtT(firstLog.ts)}, last at ${fmtT(lastLog.ts)}; e.g. ${firstLog.service} ${firstLog.level}: "${firstLog.message}".`,
          value: all.length,
          evidenceIds: uniq(
            shown.map((l) => l.id),
            3,
          ),
          quantities: [{ evidenceId: firstLog.id, field: 'ts', value: firstLog.ts, unit: 'us' }],
          derived: [d('count', all.length, 'count'), d('lastTsUs', lastLog.ts, 'us')],
          occurredAt: { tsUs: firstLog.ts, resolutionUs: 1 },
        },
      ],
      { rows },
    );
  },
};

// ---- 11. get_trace ---------------------------------------------------------------------------

const GetTrace = z.strictObject({
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  select: z.enum(['slowest', 'typical']).optional(),
  window: WindowArg.optional(),
  route: z.string().min(1).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
});
const getTrace: ToolDef<typeof GetTrace> = {
  name: 'get_trace',
  description: `One trace as a span tree. Either traceId, or select ("slowest" | "typical") with window (default incident), route and outcome (optional) to pick an example.
Findings: \`trace.<traceId>.critical_path\`: value is the category that dominates this trace's critical path (same categories as attribute_latency). Rows: the spans (offset from the root start, duration, status, key attributes).`,
  input: GetTrace,
  run: (ctx, args) => {
    let tree: TraceTree | undefined;
    if (args.traceId !== undefined) {
      const w = { window: { fromUs: 0, toUs: Number.MAX_SAFE_INTEGER }, label: 'all' };
      tree = ctx.tracesIn(w).find((t) => t.traceId === args.traceId);
    } else {
      const w = ctx.resolveWindow(args.window ?? 'incident');
      const pool = ctx
        .tracesIn(w, args.route)
        .filter(
          (t) =>
            args.outcome === undefined || (t.root.status === 'ok') === (args.outcome === 'success'),
        );
      const sorted = [...pool].sort(
        (a, b) => durationUs(a.root) - durationUs(b.root) || (a.traceId < b.traceId ? -1 : 1),
      );
      tree =
        (args.select ?? 'slowest') === 'slowest'
          ? sorted.at(-1)
          : sorted[Math.floor(sorted.length / 2)];
    }
    if (tree === undefined) return output('No such trace.', []);
    const root = tree.root;
    const totals = new Map<string, number>();
    for (const seg of criticalPath(tree))
      totals.set(seg.category, (totals.get(seg.category) ?? 0) + (seg.endUs - seg.startUs));
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const rows: Row[] = [];
    const walk = (spanId: string, depth: number): void => {
      const s = tree.byId.get(spanId);
      if (s === undefined || rows.length >= 40) return;
      const attrs = [
        SPAN_ATTRS.dbStatement,
        SPAN_ATTRS.httpStatus,
        SPAN_ATTRS.poolInUseAtAcquire,
        SPAN_ATTRS.poolCapacity,
        SPAN_ATTRS.poolWaitQueueAtAcquire,
        SPAN_ATTRS.cancelled,
      ]
        .filter((k) => s.attributes[k] !== undefined)
        .map((k) => `${k}=${String(s.attributes[k])}`)
        .join(' ');
      rows.push({
        span: `${'  '.repeat(depth)}${s.service} ${s.name}`,
        offset: fmtDur(s.startUs - root.startUs),
        duration: fmtDur(durationUs(s)),
        status: s.status,
        attrs,
        evidence: spanEvidence(s),
      });
      for (const c of tree.children.get(spanId) ?? []) walk(c.spanId, depth + 1);
    };
    walk(root.spanId, 0);
    const rootId = spanEvidence(root);
    return output(
      `Trace ${tree.traceId}: ${root.service} ${root.name}, ${root.status}, ${fmtDur(durationUs(root))}, started ${fmtT(root.startUs)}, ${String(tree.spans.length)} spans.`,
      [
        {
          key: `trace.${tree.traceId}.critical_path`,
          statement: `Trace ${tree.traceId} (${root.service} ${root.name}, ${root.status}, started ${fmtT(root.startUs)}, took ${fmtDur(durationUs(root))}): critical path is ${ranked.map(([c, us]) => `${c} ${fmtDur(us)}`).join(', ')}.`,
          value: ranked[0]?.[0] ?? 'compute',
          evidenceIds: [rootId],
          quantities: [
            { evidenceId: rootId, field: 'startUs', value: root.startUs, unit: 'us' },
            { evidenceId: rootId, field: 'durationUs', value: durationUs(root), unit: 'us' },
          ],
          derived: ranked.map(([c, us]) => d(`criticalPath.${c}`, us, 'us')),
          occurredAt: { tsUs: root.startUs, resolutionUs: 1 },
        },
      ],
      { rows },
    );
  },
};

// ---- 12. compare_windows ---------------------------------------------------------------------

const CompareWindows = z.strictObject({
  subject: z.enum(['db_queries', 'metric']),
  window: WindowArg.optional(),
  service: z.string().min(1).optional(),
  metric: MetricName.optional(),
});
const compareWindows: ToolDef<typeof CompareWindows> = {
  name: 'compare_windows',
  description: `Compares a signal between the baseline and another window (default incident), with a ~95 % interval on the ratio of medians. Arguments: subject, window, and for subject "metric": service and metric.
- subject "db_queries": DB query EXECUTION time per statement (span duration minus time queued at the DB executor). Findings: \`db_exec.<window>.flat\` (value true when at least one statement is confidently flat and none is up or down; false otherwise) and \`db_exec.<window>.<service>/<statement>.shift\` (value flat | up | down | inconclusive | insufficient-data).
- subject "metric": Finding \`metric_shift.<window>.<service>.<metric>\`: same shift values.`,
  input: CompareWindows,
  run: (ctx, args) => {
    const w = ctx.resolveWindow(args.window ?? 'incident');
    const base = ctx.windows.baseline;
    const describe = (
      c: {
        ratio: number | null;
        ratioInterval: [number, number] | null;
        baseline: { count: number; p50: number | null };
        window: { count: number; p50: number | null };
      },
      unit: string,
    ): string =>
      `median ${c.baseline.p50 === null ? 'n/a' : fmtMetric(c.baseline.p50, unit)} → ${c.window.p50 === null ? 'n/a' : fmtMetric(c.window.p50, unit)}${c.ratio === null ? '' : `, ratio ${fmtNum(c.ratio)}`}${c.ratioInterval === null ? '' : ` (95% interval ${fmtNum(c.ratioInterval[0])}–${fmtNum(c.ratioInterval[1])})`}, samples ${String(c.baseline.count)} vs ${String(c.window.count)}`;
    const quant = (
      c: {
        ratio: number | null;
        baseline: { count: number; p50: number | null };
        window: { count: number; p50: number | null };
      },
      unit: string,
    ): DerivedQuantity[] => [
      ...(c.baseline.p50 === null ? [] : [d('baselineP50', c.baseline.p50, unit)]),
      ...(c.window.p50 === null ? [] : [d('windowP50', c.window.p50, unit)]),
      ...(c.ratio === null ? [] : [d('ratio', c.ratio, 'ratio')]),
      d('baselineSamples', c.baseline.count, 'count'),
      d('windowSamples', c.window.count, 'count'),
    ];
    if (args.subject === 'metric') {
      if (args.service === undefined || args.metric === undefined)
        throw new Error('subject "metric" needs service and metric');
      const s = findSeries(ctx.series, args.service, args.metric);
      if (s === undefined) return output(`No series ${args.service}/${args.metric}.`, []);
      const c = compareSeries(s, base, w.window);
      return output(`${args.service} ${args.metric}: ${c.shift}.`, [
        {
          key: `metric_shift.${w.label}.${args.service}.${args.metric}`,
          statement: `${args.service} ${args.metric}, baseline vs ${windowWords(w.label)}: ${c.shift}; ${describe(c, s.unit)}.`,
          value: c.shift,
          evidenceIds: uniq([...c.baseline.medianEvidenceIds, ...c.window.medianEvidenceIds], 4),
          quantities: [],
          derived: quant(c, s.unit),
        },
      ]);
    }
    const profile = dbQueryProfile(ctx.spans, base, w.window);
    const findings: Finding[] = profile.exec.map((c) => ({
      key: `db_exec.${w.label}.${c.key}.shift`,
      statement: `DB execution time of ${c.key}, baseline vs ${windowWords(w.label)}: ${c.shift}; ${describe(c, 'us')}.`,
      value: c.shift,
      evidenceIds: uniq([...c.baseline.medianEvidenceIds, ...c.window.medianEvidenceIds], 4),
      quantities: [],
      derived: quant(c, 'us'),
    }));
    const counts = (shift: string): number => profile.exec.filter((c) => c.shift === shift).length;
    const queued = profile.dbQueue.filter((c) => (c.window.p95 ?? 0) > 0).map((c) => c.key);
    findings.unshift({
      key: `db_exec.${w.label}.flat`,
      statement: `DB query execution time, baseline vs ${windowWords(w.label)}, over ${String(profile.exec.length)} statements: ${String(counts('flat'))} flat, ${String(counts('up'))} up, ${String(counts('down'))} down, ${String(counts('inconclusive') + counts('insufficient-data'))} undecided. Statements with time queued at the DB executor in the window: ${queued.length === 0 ? 'none' : queued.join(', ')}.`,
      value: profile.execFlat,
      evidenceIds: uniq(
        profile.exec.flatMap((c) => c.window.medianEvidenceIds.slice(0, 1)),
        5,
      ),
      quantities: [],
      derived: [
        d('flat', counts('flat'), 'count'),
        d('up', counts('up'), 'count'),
        d('down', counts('down'), 'count'),
        d('statements', profile.exec.length, 'count'),
      ],
    });
    return output(`DB execution time flat: ${String(profile.execFlat)}.`, findings);
  },
};

// ---- 13. analyze_hold_and_wait ---------------------------------------------------------------

const analyzeHoldAndWaitTool: ToolDef<typeof WindowOnly> = {
  name: 'analyze_hold_and_wait',
  description: `Are pooled DB connections busy executing, or held idle by callers that are waiting for further connections from the same pool? Argument: window.
Two independent views: metrics (idle-held = pool_in_use − db_active_queries − DB executor queue) and spans (for each db.transaction, the share of its hold time during which its own downstream calls waited in db.pool.acquire).
Findings (all boolean unless noted):
- \`hold_and_wait.<window>.detected\`: true only if all three below are true.
- \`hold_and_wait.<window>.pool_saturated\`: median pool utilization ≥ 95 %.
- \`hold_and_wait.<window>.idle_held\`: most in-use connections are NOT executing or queued at the DB (median idle-held fraction ≥ 50 %). False means the connections are busy doing DB work.
- \`hold_and_wait.<window>.nested_wait\`: transactions spend ≥ 50 % of their hold time waiting for another connection.
- \`hold_and_wait.<window>.holder\`: value is the service whose transactions hold connections longest (or "none").`,
  input: WindowOnly,
  run: (ctx, args) => {
    const w = ctx.resolveWindow(args.window);
    const r = analyzeHoldAndWait(
      ctx.metrics.filter((m) => m.service === 'db'),
      ctx.tracesIn(w),
      w.window,
    );
    const prefix = `hold_and_wait.${w.label}`;
    const [sat, idle, nested] = r.criteria;
    const ev = uniq([...r.pool.evidenceIds, ...r.transactions.evidenceIds], 6);
    const tx = r.transactions;
    const txText =
      tx.count === 0
        ? 'no sampled transactions'
        : `${String(tx.count)} sampled transactions, hold p50 ${fmtDur(tx.holdP50Us ?? 0)}, p95 ${fmtDur(tx.holdP95Us ?? 0)}`;
    const findings: Finding[] = [
      {
        key: `${prefix}.detected`,
        statement: `Hold-and-wait in ${windowWords(w.label)}: ${r.detected ? 'DETECTED' : 'not detected'} (pool saturated: ${String(sat?.met)}; in-use connections mostly idle-held: ${String(idle?.met)}; transactions waiting for further connections: ${String(nested?.met)}).`,
        value: r.detected,
        evidenceIds: ev,
        quantities: [],
        derived: [],
      },
      {
        key: `${prefix}.pool_saturated`,
        statement: `Pool in ${windowWords(w.label)}: median ${r.pool.medianInUse === null ? 'n/a' : fmtNum(r.pool.medianInUse)} of ${r.pool.medianCapacity === null ? 'n/a' : fmtNum(r.pool.medianCapacity)} connections in use (median utilization ${r.pool.medianUtilization === null ? 'n/a' : fmtPct(r.pool.medianUtilization)}).`,
        value: sat?.met ?? false,
        evidenceIds: uniq(r.pool.evidenceIds, 4),
        quantities: [],
        derived:
          r.pool.medianUtilization === null
            ? []
            : [
                d('medianUtilization', r.pool.medianUtilization, 'ratio'),
                d('medianInUse', r.pool.medianInUse ?? 0, 'count'),
                d('medianCapacity', r.pool.medianCapacity ?? 0, 'count'),
              ],
      },
      {
        key: `${prefix}.idle_held`,
        statement: `In ${windowWords(w.label)} the DB was executing a median of ${r.pool.medianDbActive === null ? 'n/a' : fmtNum(r.pool.medianDbActive)} queries while a median of ${r.pool.medianInUse === null ? 'n/a' : fmtNum(r.pool.medianInUse)} connections were in use: median ${r.pool.medianIdleHeldFraction === null ? 'n/a' : fmtPct(r.pool.medianIdleHeldFraction)} of in-use connections were held without executing or queueing at the DB.`,
        value: idle?.met ?? false,
        evidenceIds: uniq(r.pool.evidenceIds, 4),
        quantities: [],
        derived:
          r.pool.medianIdleHeldFraction === null
            ? []
            : [
                d('medianIdleHeldFraction', r.pool.medianIdleHeldFraction, 'ratio'),
                d('medianDbActive', r.pool.medianDbActive ?? 0, 'count'),
              ],
      },
      {
        key: `${prefix}.nested_wait`,
        statement: `Transactions in ${windowWords(w.label)}: ${txText}; ${tx.nestedWaitShare === null ? 'n/a' : fmtPct(tx.nestedWaitShare)} of their connection-hold time was spent while their own downstream calls waited in db.pool.acquire${tx.waiters.length === 0 ? '' : ` (waiting services: ${tx.waiters.map((x) => x.service).join(', ')})`}.`,
        value: nested?.met ?? false,
        evidenceIds: uniq(tx.evidenceIds, 5),
        quantities: [],
        derived:
          tx.nestedWaitShare === null
            ? []
            : [
                d('nestedWaitShare', tx.nestedWaitShare, 'ratio'),
                d('transactions', tx.count, 'count'),
                d('holdP50Us', tx.holdP50Us ?? 0, 'us'),
                d('holdP95Us', tx.holdP95Us ?? 0, 'us'),
              ],
      },
      {
        key: `${prefix}.holder`,
        statement:
          tx.holders.length === 0
            ? `No transaction held a connection in ${windowWords(w.label)}.`
            : `Connections are held in transactions by: ${tx.holders.map((x) => `${x.service} (${fmtDur(x.holdUs)} total hold time in sampled traces)`).join(', ')}.`,
        value: tx.holders[0]?.service ?? 'none',
        evidenceIds: uniq(tx.evidenceIds, 5),
        quantities: [],
        derived: tx.holders.map((x) => d(`holdUs.${x.service}`, x.holdUs, 'us')),
      },
    ];
    return output(
      `Hold-and-wait ${r.detected ? 'detected' : 'not detected'} in ${windowWords(w.label)}.`,
      findings,
    );
  },
};

// ---- 14. correlate_changes -------------------------------------------------------------------

const correlateChangesTool: ToolDef = {
  name: 'correlate_changes',
  description: `For each change event: did anomalies begin in the changed service or its dependencies/dependents within 120 s after it, and are they better explained by something else? Correlation only, never causation. No arguments.
Findings: \`change_correlation.<id>.verdict\`: value correlated (the changed service itself shows an unexplained anomaly) | weak (only related services do) | none (nothing related, or everything is explained by an unrelated dependency or a later change). The statement gives the reason.`,
  input: z.strictObject({}),
  run: (ctx) => {
    const res = correlateChanges(ctx.changes, ctx.anomalies.anomalies, ctx.graph);
    const findings: Finding[] = res.map((c) => {
      const self = c.following.filter((f) => f.relation === 'self');
      return {
        key: `change_correlation.${c.changeId}.verdict`,
        statement: `${c.changeId} (${c.service}, ${fmtT(c.ts)}): ${c.verdict}. ${c.reason}. ${String(c.following.filter((f) => f.relation !== 'unrelated').length)} anomalies began in related services within the lag; ${c.sustained ? 'at least one is still ongoing' : 'none is still ongoing'}.`,
        value: c.verdict,
        evidenceIds: uniq(
          [
            c.changeId,
            ...self.flatMap((f) => f.evidenceIds),
            ...c.following.flatMap((f) => f.evidenceIds),
          ],
          5,
        ),
        quantities: [{ evidenceId: c.changeId, field: 'ts', value: c.ts, unit: 'us' }],
        derived: [
          d(
            'relatedAnomalies',
            c.following.filter((f) => f.relation !== 'unrelated').length,
            'count',
          ),
        ],
        occurredAt: { tsUs: c.ts, resolutionUs: 1 },
      };
    });
    return output(
      `Change correlation: ${res.map((c) => `${c.changeId} ${c.verdict}`).join(', ') || 'no change events'}.`,
      findings,
    );
  },
};

export const DATA_TOOLS: readonly ToolDef[] = [
  getIncidentWindow,
  listChangeEvents,
  getMetricSeries,
  detectAnomaliesTool,
  buildTimelineTool,
  getDependencyGraph,
  attributeLatencyTool,
  getSaturation,
  analyzePropagationTool,
  searchLogs,
  getTrace,
  compareWindows,
  analyzeHoldAndWaitTool,
  correlateChangesTool,
  getPodEvents,
  getRetryStats,
] as readonly ToolDef[];

export const DATA_TOOL_NAMES: readonly string[] = DATA_TOOLS.map((t) => t.name);
