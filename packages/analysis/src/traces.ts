// Span classification, trace trees and critical-path extraction.
//
// Everything here works from span NAMES and ATTRIBUTES (the OTel-shaped conventions in
// @tracepilot/schema), never from simulator configuration.

import { SPAN_ATTRS, SPAN_NAMES, type Span } from '@tracepilot/schema';

export type SpanKind =
  'server' | 'queue_wait' | 'pool_acquire' | 'db_query' | 'db_transaction' | 'external';

export function spanKind(s: Span): SpanKind {
  switch (s.name) {
    case SPAN_NAMES.queueWait:
      return 'queue_wait';
    case SPAN_NAMES.poolAcquire:
      return 'pool_acquire';
    case SPAN_NAMES.dbQuery:
      return 'db_query';
    case SPAN_NAMES.dbTransaction:
      return 'db_transaction';
    default:
      return typeof s.attributes[SPAN_ATTRS.peerService] === 'string' ? 'external' : 'server';
  }
}

export const spanEvidence = (s: Span): string => `sp_${s.spanId}`;
export const durationUs = (s: Span): number => s.endUs - s.startUs;

/** Part of a db.query span spent queued at the DB executor (0 when not recorded). */
export function dbQueueWaitUs(s: Span): number {
  const v = s.attributes[SPAN_ATTRS.dbQueueWaitUs];
  return typeof v === 'number' ? Math.min(Math.max(0, v), durationUs(s)) : 0;
}

/** Pure execution time of a db.query span: duration minus DB executor queue wait. */
export const dbExecUs = (s: Span): number => durationUs(s) - dbQueueWaitUs(s);

export interface TraceTree {
  traceId: string;
  root: Span;
  spans: Span[];
  byId: Map<string, Span>;
  /** spanId → children ordered by start time. */
  children: Map<string, Span[]>;
}

/**
 * Groups spans into traces. Traces without exactly one root, or with spans whose parent is
 * missing, are dropped: their structure cannot be trusted. Returned in root start order.
 */
export function buildTraces(spans: readonly Span[]): TraceTree[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) {
    const list = byTrace.get(s.traceId);
    if (list === undefined) byTrace.set(s.traceId, [s]);
    else list.push(s);
  }
  const out: TraceTree[] = [];
  for (const [traceId, list] of byTrace) {
    const roots = list.filter((s) => s.parentSpanId === null);
    const root = roots[0];
    if (root === undefined || roots.length !== 1) continue;
    const byId = new Map(list.map((s) => [s.spanId, s]));
    if (list.some((s) => s.parentSpanId !== null && !byId.has(s.parentSpanId))) continue;
    const children = new Map<string, Span[]>();
    for (const s of list) {
      if (s.parentSpanId === null) continue;
      const c = children.get(s.parentSpanId);
      if (c === undefined) children.set(s.parentSpanId, [s]);
      else c.push(s);
    }
    for (const c of children.values())
      c.sort((a, b) => a.startUs - b.startUs || cmp(a.spanId, b.spanId));
    out.push({ traceId, root, spans: list, byId, children });
  }
  return out.sort((a, b) => a.root.startUs - b.root.startUs || cmp(a.traceId, b.traceId));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ancestors of a span, nearest first. */
export function ancestors(tree: TraceTree, span: Span): Span[] {
  const out: Span[] = [];
  let cur = span.parentSpanId === null ? undefined : tree.byId.get(span.parentSpanId);
  while (cur !== undefined) {
    out.push(cur);
    cur = cur.parentSpanId === null ? undefined : tree.byId.get(cur.parentSpanId);
  }
  return out;
}

/** Descendants of a span (depth-first). */
export function descendants(tree: TraceTree, span: Span): Span[] {
  const out: Span[] = [];
  const stack = [...(tree.children.get(span.spanId) ?? [])];
  while (stack.length > 0) {
    const s = stack.pop() as Span;
    out.push(s);
    stack.push(...(tree.children.get(s.spanId) ?? []));
  }
  return out;
}

export type TimeCategory =
  'queue_wait' | 'pool_acquire' | 'db_queue' | 'query_exec' | 'external' | 'compute';

export const TIME_CATEGORIES: readonly TimeCategory[] = [
  'queue_wait',
  'pool_acquire',
  'db_queue',
  'query_exec',
  'external',
  'compute',
];

export interface PathSegment {
  span: Span;
  startUs: number;
  endUs: number;
  category: TimeCategory;
  /** True when the request held a DB connection (inside a db.transaction) during this segment. */
  heldConnection: boolean;
  /** Services of the server spans enclosing this segment, outermost first (excluding its own). */
  enclosingServices: string[];
}

/**
 * Critical path of a trace: the chain of work that determined the root span's duration. Walks
 * backwards from the end of each span, always descending into the child that finished last
 * before the cursor; time not covered by a child is the span's own (self) time.
 *
 * Children that outlive their parent (abandoned work after a cancellation) are clipped to the
 * parent: only the part the parent actually waited for is on the critical path.
 *
 * The segments exactly tile [root.startUs, root.endUs].
 */
export function criticalPath(tree: TraceTree): PathSegment[] {
  const segments: PathSegment[] = [];

  const self = (span: Span, from: number, to: number, held: boolean, enclosing: string[]): void => {
    if (to <= from) return;
    const kind = spanKind(span);
    const push = (a: number, b: number, category: TimeCategory): void => {
      if (b > a)
        segments.push({
          span,
          startUs: a,
          endUs: b,
          category,
          heldConnection: held,
          enclosingServices: enclosing,
        });
    };
    switch (kind) {
      case 'queue_wait':
        push(from, to, 'queue_wait');
        return;
      case 'pool_acquire':
        push(from, to, 'pool_acquire');
        return;
      case 'external':
        push(from, to, 'external');
        return;
      case 'db_query': {
        const split = span.startUs + dbQueueWaitUs(span);
        push(from, Math.min(to, split), 'db_queue');
        push(Math.max(from, split), to, 'query_exec');
        return;
      }
      case 'server':
      case 'db_transaction':
        push(from, to, 'compute');
        return;
    }
  };

  const walk = (span: Span, from: number, to: number, held: boolean, enclosing: string[]): void => {
    const kind = spanKind(span);
    const isHeld = held || kind === 'db_transaction';
    const innerEnclosing = kind === 'server' ? [...enclosing, span.service] : enclosing;
    const remaining = (tree.children.get(span.spanId) ?? []).filter(
      (c) => c.startUs < to && c.endUs > from,
    );
    let cursor = to;
    while (cursor > from) {
      let best: Span | undefined;
      let bestEnd = -1;
      for (const c of remaining) {
        if (Math.max(c.startUs, from) >= cursor) continue;
        const end = Math.min(c.endUs, cursor);
        if (end > bestEnd || (end === bestEnd && best !== undefined && c.startUs > best.startUs)) {
          best = c;
          bestEnd = end;
        }
      }
      if (best === undefined) {
        self(span, from, cursor, isHeld, enclosing);
        break;
      }
      if (bestEnd < cursor) self(span, bestEnd, cursor, isHeld, enclosing);
      const childFrom = Math.max(best.startUs, from);
      walk(best, childFrom, bestEnd, isHeld, innerEnclosing);
      cursor = childFrom;
      remaining.splice(remaining.indexOf(best), 1);
    }
  };

  walk(tree.root, tree.root.startUs, tree.root.endUs, false, []);
  return segments.sort((a, b) => a.startUs - b.startUs);
}

/** Total length of the union of intervals, clipped to [from, to). */
export function unionLength(
  intervals: readonly [number, number][],
  from: number,
  to: number,
): number {
  const clipped = intervals
    .map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = -1;
  let curB = -1;
  for (const [a, b] of clipped) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a;
      curB = b;
    } else if (b > curB) {
      curB = b;
    }
  }
  if (curB > curA) total += curB - curA;
  return total;
}
