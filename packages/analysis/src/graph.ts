// Dependency graph derived from spans (brief §4.3), never from configuration.
//
// - call edge A → B: a server span of B whose parent span belongs to A.
// - database edge A → db: db access by A. Attempts = executed queries + acquires that failed
//   (they never reached the DB). Latency = db.query duration of executed queries.
// - external edge A → peer: client spans carrying `peer.service`.
// Counts come from sampled traces.

import {
  DependencyGraph,
  SPAN_ATTRS,
  type DependencyEdgeKind,
  type DependencyNodeKind,
  type Span,
} from '@tracepilot/schema';
import { quantile } from './stats.ts';
import { durationUs, spanEvidence, spanKind } from './traces.ts';

/** Telemetry name of the database component (db.* spans and metrics). */
export const DB_NODE = 'db';

const EVIDENCE_PER_EDGE = 5;

export function buildDependencyGraph(spans: readonly Span[]): DependencyGraph {
  const byId = new Map<string, Span>();
  for (const s of spans) byId.set(`${s.traceId}/${s.spanId}`, s);

  const nodes = new Map<
    string,
    { kind: DependencyNodeKind; spanCount: number; errorCount: number }
  >();
  const node = (service: string, kind: DependencyNodeKind) => {
    let n = nodes.get(service);
    if (n === undefined) {
      n = { kind, spanCount: 0, errorCount: 0 };
      nodes.set(service, n);
    }
    return n;
  };
  interface EdgeAcc {
    from: string;
    to: string;
    kind: DependencyEdgeKind;
    ops: Set<string>;
    calls: number;
    errors: number;
    latencies: number[];
    evidence: string[];
  }
  const edges = new Map<string, EdgeAcc>();
  const edge = (from: string, to: string, kind: DependencyEdgeKind): EdgeAcc => {
    const key = `${from}→${to}`;
    let e = edges.get(key);
    if (e === undefined) {
      e = { from, to, kind, ops: new Set(), calls: 0, errors: 0, latencies: [], evidence: [] };
      edges.set(key, e);
    }
    return e;
  };
  const entry = new Set<string>();
  /** Name of the nearest enclosing server span of the span's own service. */
  const operationOf = (s: Span): string => {
    let cur: Span | undefined = s;
    while (cur !== undefined) {
      if (cur.service === s.service && spanKind(cur) === 'server') return cur.name;
      cur = cur.parentSpanId === null ? undefined : byId.get(`${cur.traceId}/${cur.parentSpanId}`);
    }
    return '?';
  };

  for (const s of spans) {
    const kind = spanKind(s);
    const failed = s.status !== 'ok';
    if (kind === 'server') {
      const n = node(s.service, 'service');
      n.spanCount++;
      if (failed) n.errorCount++;
      if (s.parentSpanId === null) {
        entry.add(s.service);
        continue;
      }
      const parent = byId.get(`${s.traceId}/${s.parentSpanId}`);
      if (parent === undefined || parent.service === s.service) continue;
      const e = edge(parent.service, s.service, 'call');
      e.ops.add(operationOf(parent));
      e.calls++;
      if (failed) e.errors++;
      e.latencies.push(durationUs(s));
      if (e.evidence.length < EVIDENCE_PER_EDGE) e.evidence.push(spanEvidence(s));
    } else if (kind === 'db_query' || (kind === 'pool_acquire' && failed)) {
      node(s.service, 'service');
      const db = node(DB_NODE, 'database');
      db.spanCount++;
      if (failed) db.errorCount++;
      const e = edge(s.service, DB_NODE, 'database');
      e.ops.add(operationOf(s));
      e.calls++;
      if (failed) e.errors++;
      if (kind === 'db_query' && !failed) e.latencies.push(durationUs(s));
      if (e.evidence.length < EVIDENCE_PER_EDGE) e.evidence.push(spanEvidence(s));
    } else if (kind === 'external') {
      const peer = s.attributes[SPAN_ATTRS.peerService];
      if (typeof peer !== 'string') continue;
      node(s.service, 'service');
      const p = node(peer, 'external');
      p.spanCount++;
      if (failed) p.errorCount++;
      const e = edge(s.service, peer, 'external');
      e.ops.add(operationOf(s));
      e.calls++;
      if (failed) e.errors++;
      e.latencies.push(durationUs(s));
      if (e.evidence.length < EVIDENCE_PER_EDGE) e.evidence.push(spanEvidence(s));
    }
  }

  const sortKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return DependencyGraph.parse({
    nodes: [...nodes.entries()]
      .sort(([a], [b]) => sortKey(a, b))
      .map(([service, n]) => ({ service, ...n })),
    edges: [...edges.values()]
      .sort((a, b) => sortKey(a.from, b.from) || sortKey(a.to, b.to))
      .map((e) => ({
        from: e.from,
        to: e.to,
        kind: e.kind,
        callerOperations: [...e.ops].sort(),
        callCount: e.calls,
        errorCount: e.errors,
        latencyP50Us: e.latencies.length === 0 ? 0 : Math.round(quantile(e.latencies, 0.5)),
        latencyP95Us: e.latencies.length === 0 ? 0 : Math.round(quantile(e.latencies, 0.95)),
        evidenceIds: e.evidence,
      })),
    entryServices: [...entry].sort(),
  });
}

/** Direct callees of a node. */
export const calleesOf = (g: DependencyGraph, service: string): string[] =>
  g.edges.filter((e) => e.from === service).map((e) => e.to);

/** Direct callers of a node. */
export const callersOf = (g: DependencyGraph, service: string): string[] =>
  g.edges.filter((e) => e.to === service).map((e) => e.from);

function closure(start: string, next: (s: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const stack = next(start);
  while (stack.length > 0) {
    const s = stack.pop() as string;
    if (seen.has(s) || s === start) continue;
    seen.add(s);
    stack.push(...next(s));
  }
  return seen;
}

/** Everything a service depends on, transitively. */
export const downstreamOf = (g: DependencyGraph, service: string): Set<string> =>
  closure(service, (s) => calleesOf(g, s));

/** Everything that depends on a service, transitively. */
export const upstreamOf = (g: DependencyGraph, service: string): Set<string> =>
  closure(service, (s) => callersOf(g, s));
