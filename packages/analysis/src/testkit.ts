// Builders for synthetic telemetry with known answers. Test-only; not exported by the package.

import type { MetricName, MetricPoint, Span, SpanStatus } from '@tracepilot/schema';
import { toSeries, type Series } from './series.ts';
import { buildTraces, type TraceTree } from './traces.ts';

export const MS = 1_000;
export const S = 1_000_000;
export const TICK = 5 * S;

/** Deterministic noise in [-amp, amp] (an LCG; analysis code may not use Math.random). */
export function noise(n: number, seed: number, amp: number): number[] {
  let x = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push(((x / 4294967296) * 2 - 1) * amp);
  }
  return out;
}

/** Metric points for one series, one sample per tick starting at `startUs`. */
export function points(
  service: string,
  name: MetricName,
  values: readonly number[],
  startUs = TICK,
  stepUs = TICK,
): MetricPoint[] {
  return values.map((value, i) => ({ ts: startUs + i * stepUs, service, name, value, labels: {} }));
}

export function series(
  service: string,
  name: MetricName,
  values: readonly number[],
  startUs = TICK,
): Series {
  const s = toSeries(points(service, name, values, startUs))[0];
  if (s === undefined) throw new Error('empty series');
  return s;
}

/** Sample index → timestamp for series built with the defaults. */
export const at = (i: number): number => TICK + i * TICK;

let spanCounter = 0;
let traceCounter = 0;
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

/** Builds the spans of one trace with explicit structure and times. */
export class TraceBuilder {
  readonly traceId = hex(++traceCounter, 32);
  readonly spans: Span[] = [];

  span(
    service: string,
    name: string,
    startUs: number,
    endUs: number,
    opts: { parent?: string | null; status?: SpanStatus; attrs?: Span['attributes'] } = {},
  ): string {
    const spanId = hex(++spanCounter, 16);
    this.spans.push({
      traceId: this.traceId,
      spanId,
      parentSpanId: opts.parent ?? null,
      service,
      name,
      startUs,
      endUs,
      status: opts.status ?? 'ok',
      attributes: opts.attrs ?? {},
    });
    return spanId;
  }

  tree(): TraceTree {
    const t = buildTraces(this.spans)[0];
    if (t === undefined) throw new Error('trace is not well formed');
    return t;
  }
}

/**
 * A checkout-like request: gateway → checkout [transaction: query, then calls to inventory
 * (pool acquire + query)]. `acquireWaitUs` is the wait of inventory's acquire while checkout holds
 * its connection: 0 for a healthy request, large for hold-and-wait.
 */
export function checkoutTrace(
  t0: number,
  opts: { acquireWaitUs?: number; status?: SpanStatus; queryUs?: number } = {},
): TraceBuilder {
  const wait = opts.acquireWaitUs ?? 0;
  const q = opts.queryUs ?? 10 * MS;
  const status = opts.status ?? 'ok';
  const b = new TraceBuilder();
  const end = t0 + 2 * MS + q + wait + q + 2 * MS;
  const gw = b.span('api-gateway', 'checkout', t0, end, { status });
  const co = b.span('checkout', 'place-order', t0 + MS, end - MS, { parent: gw, status });
  const txStart = t0 + MS;
  b.span('checkout', 'db.pool.acquire', txStart, txStart, {
    parent: co,
    attrs: { 'db.pool.capacity': 10, 'db.pool.in_use': wait > 0 ? 10 : 3, 'db.pool.wait_queue': 0 },
  });
  const tx = b.span('checkout', 'db.transaction', txStart, end - MS, { parent: co, status });
  b.span('checkout', 'db.query', txStart, txStart + q, {
    parent: tx,
    attrs: { 'db.statement': 'load', 'db.queue_wait_us': 0 },
  });
  const inv = b.span('inventory', 'reserve', txStart + q, end - MS, { parent: tx, status });
  b.span('inventory', 'db.pool.acquire', txStart + q, txStart + q + wait, {
    parent: inv,
    status: status === 'ok' ? 'ok' : 'timeout',
    attrs: {
      'db.pool.capacity': 10,
      'db.pool.in_use': wait > 0 ? 10 : 4,
      'db.pool.wait_queue': wait > 0 ? 5 : 0,
    },
  });
  if (status === 'ok') {
    b.span('inventory', 'db.query', txStart + q + wait, txStart + q + wait + q, {
      parent: inv,
      attrs: { 'db.statement': 'reserve', 'db.queue_wait_us': 0 },
    });
  }
  return b;
}
