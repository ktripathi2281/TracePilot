// Propagation analysis (brief §4.6).
//
// 1. Per node, the onset of its earliest INCIDENT-RELEVANT anomaly. Relevant = still ongoing, or
//    recovered after the incident started. Anomalies that recovered before the incident (such as
//    a short, self-resolving blip minutes earlier) are reported as `excluded`, with the reason.
//    Callers may supply finer, span-refined onsets per node; one is used only if it is
//    consistent with the metric onset (not later than it by more than the metric resolution).
// 2. Per dependency edge with both ends anomalous: does the callee's onset precede the caller's
//    (consistent with failure propagating upward)? Onsets within the coarser resolution, e.g. one
//    metric tick, are `inconclusive`, never ordered.
// 3. Failure paths: from each entry service, follow edges into anomalous callees until no callee
//    is anomalous. The node where a path ends is a candidate ORIGIN of the user-facing symptom.
//    Candidates are ranked: a path with a precedence violation ranks below consistent ones; then
//    by earliest onset.
//
// This orders and connects evidence; it does not claim causation.

import type { DependencyGraph } from '@tracepilot/schema';
import type { Anomaly } from './anomaly.ts';
import { calleesOf } from './graph.ts';
import {
  comparePrecedence,
  onsetFromAnomaly,
  type OnsetEstimate,
  type Precedence,
} from './precedence.ts';
import type { Window } from './series.ts';

export interface PropagationOptions {
  /** The incident (symptom) window; anomalies recovered before it starts are excluded. */
  incident: Window;
  /** Span-refined onsets that replace a node's metric onset when present. */
  refinedOnsets?: Readonly<Record<string, OnsetEstimate>>;
  /**
   * Span-refined onsets per `service/operation`. For an edge, the caller's onset is taken from
   * the operations that make that call (DependencyEdge.callerOperations): a gateway whose
   * `stock` route failed first must not look "earlier" than checkout, which it never calls on
   * that route.
   */
  refinedByOperation?: Readonly<Record<string, OnsetEstimate>>;
  /** Max number of paths reported. Default 50. */
  maxPaths?: number;
}

export interface NodeOnset {
  service: string;
  onset: OnsetEstimate;
  /** The metric anomaly that set it (earliest relevant one). */
  anomaly: { metric: string; direction: string; status: string };
  /** Metric-level onset, kept when a span-refined onset replaced it. */
  metricOnset: OnsetEstimate;
  refinement: 'none' | 'applied' | 'rejected-later-than-metric';
}

export interface EdgePrecedence {
  caller: string;
  callee: string;
  /** a = callee, b = caller. `a_before_b` = consistent with upward propagation. */
  precedence: Precedence;
  consistent: boolean | null;
}

export interface FailurePath {
  /** Entry service first, origin candidate last. */
  nodes: string[];
  hops: EdgePrecedence[];
  /** True if no hop has the caller strictly before the callee. */
  consistent: boolean;
  /** Hops that could be ordered (not inconclusive). */
  orderedHops: number;
}

export interface OriginCandidate {
  service: string;
  onset: OnsetEstimate;
  paths: number;
  consistentPaths: number;
}

export interface PropagationResult {
  onsets: NodeOnset[];
  excluded: {
    service: string;
    metric: string;
    onsetUs: number;
    endUs: number | null;
    reason: string;
  }[];
  edges: EdgePrecedence[];
  paths: FailurePath[];
  origins: OriginCandidate[];
}

export function analyzePropagation(
  graph: DependencyGraph,
  anomalies: readonly Anomaly[],
  opts: PropagationOptions,
): PropagationResult {
  const excluded: PropagationResult['excluded'] = [];
  const earliest = new Map<string, Anomaly>();
  for (const a of anomalies) {
    if (a.status === 'recovered' && a.endUs !== null && a.endUs <= opts.incident.fromUs) {
      excluded.push({
        service: a.service,
        metric: a.metric,
        onsetUs: a.onsetUs,
        endUs: a.endUs,
        reason: 'recovered before the incident window started',
      });
      continue;
    }
    if (a.onsetUs >= opts.incident.toUs) continue;
    const cur = earliest.get(a.service);
    if (cur === undefined || a.onsetUs < cur.onsetUs) earliest.set(a.service, a);
  }

  const onsets: NodeOnset[] = [...earliest.entries()]
    .map(([service, a]) => {
      const metricOnset = onsetFromAnomaly(a);
      const refined = opts.refinedOnsets?.[service];
      // Span and metric onsets are two measurements of one change. They are consistent when the
      // span onset is no later than the metric onset plus the metric resolution: the upper end of
      // a metric interval can itself be a noisy sample next to the shift. A span onset later
      // than that means sampling missed the start, so the metric onset is kept.
      const usable =
        refined !== undefined && refined.ts <= metricOnset.ts + metricOnset.resolutionUs;
      return {
        service,
        onset: usable ? refined : metricOnset,
        anomaly: { metric: a.metric, direction: a.direction, status: a.status },
        metricOnset,
        refinement:
          refined === undefined
            ? ('none' as const)
            : usable
              ? ('applied' as const)
              : ('rejected-later-than-metric' as const),
      };
    })
    .sort((x, y) => x.onset.ts - y.onset.ts || (x.service < y.service ? -1 : 1));
  const onsetOf = new Map(onsets.map((o) => [o.service, o.onset]));

  const edges: EdgePrecedence[] = [];
  const edgeKey = new Map<string, EdgePrecedence>();
  for (const e of graph.edges) {
    const callee = onsetOf.get(e.to);
    const node = onsetOf.get(e.from);
    if (callee === undefined || node === undefined) continue;
    const metric = onsets.find((o) => o.service === e.from)?.metricOnset ?? node;
    const opOnsets = e.callerOperations
      .map((op) => opts.refinedByOperation?.[`${e.from}/${op}`])
      .filter((o): o is OnsetEstimate => o !== undefined && o.ts <= metric.ts + metric.resolutionUs)
      .sort((x, y) => x.ts - y.ts);
    const caller = opOnsets[0] ?? node;
    const precedence = comparePrecedence(callee, caller);
    const ep: EdgePrecedence = {
      caller: e.from,
      callee: e.to,
      precedence,
      consistent:
        precedence.verdict === 'inconclusive' ? null : precedence.verdict === 'a_before_b',
    };
    edges.push(ep);
    edgeKey.set(`${e.from}→${e.to}`, ep);
  }

  const maxPaths = opts.maxPaths ?? 50;
  const paths: FailurePath[] = [];
  const walk = (node: string, trail: string[]): void => {
    if (paths.length >= maxPaths) return;
    const next = calleesOf(graph, node)
      .filter((c) => onsetOf.has(c) && !trail.includes(c))
      .sort();
    if (next.length === 0) {
      if (trail.length < 2) return;
      const hops = trail
        .slice(1)
        .map((callee, i) => edgeKey.get(`${trail[i] ?? ''}→${callee}`) as EdgePrecedence);
      paths.push({
        nodes: trail,
        hops,
        consistent: hops.every((h) => h.consistent !== false),
        orderedHops: hops.filter((h) => h.consistent !== null).length,
      });
      return;
    }
    for (const c of next) walk(c, [...trail, c]);
  };
  for (const entry of graph.entryServices) if (onsetOf.has(entry)) walk(entry, [entry]);

  const originMap = new Map<string, OriginCandidate>();
  for (const p of paths) {
    const origin = p.nodes.at(-1) as string;
    const c = originMap.get(origin) ?? {
      service: origin,
      onset: onsetOf.get(origin) as OnsetEstimate,
      paths: 0,
      consistentPaths: 0,
    };
    c.paths++;
    if (p.consistent) c.consistentPaths++;
    originMap.set(origin, c);
  }
  const origins = [...originMap.values()].sort(
    (a, b) =>
      Number(b.consistentPaths > 0) - Number(a.consistentPaths > 0) ||
      a.onset.ts - b.onset.ts ||
      (a.service < b.service ? -1 : 1),
  );
  return { onsets, excluded, edges, paths, origins };
}
