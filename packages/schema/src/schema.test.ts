import { describe, expect, it } from 'vitest';
import {
  ChangeEvent,
  DependencyGraph,
  Diagnosis,
  EvidenceId,
  FactEntry,
  Hypothesis,
  InferenceEntry,
  LedgerEntry,
  LogRecord,
  METRIC_SAMPLE_INTERVAL_US,
  MetricPoint,
  Patch,
  PodEvent,
  Span,
  evidenceKind,
  formatPatch,
  metricEvidenceId,
  parseMetricEvidenceId,
  parsePatchArg,
  spanEvidenceId,
} from './index.ts';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';
const PARENT = '00f067aa0ba902b7';

const span = (over: Record<string, unknown> = {}) => ({
  traceId: TRACE,
  spanId: SPAN,
  parentSpanId: PARENT,
  service: 'checkout',
  name: 'db.pool.acquire',
  startUs: 1_000,
  endUs: 5_000,
  status: 'ok',
  attributes: { 'db.pool.capacity': 30, 'db.pool.in_use': 30 },
  ...over,
});

describe('evidence ids', () => {
  it('builds and classifies each kind', () => {
    expect(spanEvidenceId(SPAN)).toBe(`sp_${SPAN}`);
    expect(evidenceKind(`sp_${SPAN}`)).toBe('span');
    expect(evidenceKind('lg_1a')).toBe('log');
    expect(evidenceKind('ev_7')).toBe('change');
    expect(evidenceKind('pe_3')).toBe('pod');
    expect(evidenceKind(metricEvidenceId('checkout', 'latency_p99', 600_000_000))).toBe('metric');
  });

  it('rejects malformed ids', () => {
    for (const bad of [
      'sp_xyz',
      'lg_',
      'LG_1',
      'xx_1',
      'mt_checkout_latency',
      'mt_Check_out_x_1',
      '',
    ]) {
      expect(evidenceKind(bad), bad).toBeUndefined();
      expect(EvidenceId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('round-trips metric ids even when metric names contain underscores and digits', () => {
    const id = metricEvidenceId('api-gateway', 'latency_p99', 123_000_000);
    expect(id).toBe('mt_api-gateway_latency_p99_123000000');
    expect(parseMetricEvidenceId(id)).toEqual({
      service: 'api-gateway',
      metric: 'latency_p99',
      ts: 123_000_000,
    });
  });

  it('refuses service names that would make metric ids ambiguous', () => {
    expect(() => metricEvidenceId('check_out', 'request_rate', 0)).toThrow();
    expect(() => metricEvidenceId('checkout', 'request_rate', -1)).toThrow();
    expect(() => metricEvidenceId('checkout', 'request_rate', 1.5)).toThrow();
  });
});

describe('telemetry', () => {
  it('accepts a valid span', () => {
    expect(Span.parse(span())).toMatchObject({ name: 'db.pool.acquire' });
    expect(Span.parse(span({ parentSpanId: null })).parentSpanId).toBeNull();
  });

  it('rejects spans with negative duration, self-parenting, non-integer time, or unknown keys', () => {
    expect(Span.safeParse(span({ endUs: 999 })).success).toBe(false);
    expect(Span.safeParse(span({ parentSpanId: SPAN })).success).toBe(false);
    expect(Span.safeParse(span({ startUs: 1.5 })).success).toBe(false);
    expect(Span.safeParse(span({ status: 'cancelled' })).success).toBe(false);
    expect(Span.safeParse(span({ extra: 1 })).success).toBe(false);
    expect(Span.safeParse(span({ spanId: 'B7AD6B7169203331' })).success).toBe(false);
  });

  it('validates logs', () => {
    const log = {
      id: 'lg_42',
      ts: 10,
      service: 'checkout',
      level: 'error',
      message: 'timeout acquiring connection after 5000ms',
      fields: { waitedMs: 5000 },
      traceId: TRACE,
    };
    expect(LogRecord.parse(log).traceId).toBe(TRACE);
    const { traceId: _t, ...noTrace } = log;
    expect(LogRecord.safeParse(noTrace).success).toBe(true);
    expect(LogRecord.safeParse({ ...log, level: 'fatal' }).success).toBe(false);
  });

  it('validates metric points, units and ranges', () => {
    const p = {
      ts: METRIC_SAMPLE_INTERVAL_US,
      service: 'db',
      name: 'pool_in_use',
      value: 30,
      labels: {},
    };
    expect(MetricPoint.safeParse(p).success).toBe(true);
    expect(MetricPoint.safeParse({ ...p, name: 'made_up_metric' }).success).toBe(false);
    expect(MetricPoint.safeParse({ ...p, value: Number.NaN }).success).toBe(false);
    expect(MetricPoint.safeParse({ ...p, value: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(MetricPoint.safeParse({ ...p, value: -1 }).success).toBe(false);
    expect(MetricPoint.safeParse({ ...p, name: 'error_rate', value: 0.2 }).success).toBe(true);
    expect(MetricPoint.safeParse({ ...p, name: 'error_rate', value: 1.2 }).success).toBe(false);
  });

  it('validates change and pod events', () => {
    expect(
      ChangeEvent.safeParse({
        id: 'ev_1',
        ts: 600_000_000,
        kind: 'deploy',
        service: 'checkout',
        description: 'checkout v2.4.1',
        diff: { workers: { from: 20, to: 60 }, version: { from: '2.4.0', to: '2.4.1' } },
      }).success,
    ).toBe(true);
    expect(
      ChangeEvent.safeParse({
        id: 'ev_1',
        ts: 0,
        kind: 'hotfix',
        service: 'x',
        description: 'd',
        diff: {},
      }).success,
    ).toBe(false);
    expect(
      PodEvent.safeParse({
        id: 'pe_1',
        ts: 0,
        service: 'checkout',
        pod: 'checkout-7d9f-abc12',
        reason: 'OOMKilled',
        message: 'container exceeded memory limit',
      }).success,
    ).toBe(true);
  });
});

describe('topology', () => {
  it('requires edges to reference nodes', () => {
    const node = (service: string) => ({ service, spanCount: 1, errorCount: 0 });
    const edge = {
      from: 'checkout',
      to: 'db',
      callCount: 10,
      errorCount: 0,
      latencyP50Us: 1,
      latencyP95Us: 2,
      evidenceIds: [`sp_${SPAN}`],
    };
    expect(
      DependencyGraph.safeParse({ nodes: [node('checkout'), node('db')], edges: [edge] }).success,
    ).toBe(true);
    expect(DependencyGraph.safeParse({ nodes: [node('checkout')], edges: [edge] }).success).toBe(
      false,
    );
  });
});

describe('evidence ledger', () => {
  const fact = {
    id: 'le_1',
    author: 'investigator',
    type: 'FACT',
    statement: 'pool_in_use reached 30/30 at T+10m05s',
    tool: 'get_metric_series',
    evidenceIds: ['mt_db_pool_in_use_605000000'],
    quantities: [
      { evidenceId: 'mt_db_pool_in_use_605000000', field: 'value', value: 30, unit: 'count' },
    ],
  };

  it('accepts each entry type', () => {
    expect(LedgerEntry.parse(fact).type).toBe('FACT');
    expect(
      LedgerEntry.parse({
        id: 'le_2',
        author: 'investigator',
        type: 'INFERENCE',
        statement: 'pool saturation precedes latency rise',
        rule: 'onset-order-along-dependency-edge',
        premises: ['le_1'],
      }).type,
    ).toBe('INFERENCE');
    expect(
      LedgerEntry.parse({
        id: 'le_3',
        author: 'skeptic',
        type: 'HYPOTHESIS',
        statement: 'DB is slow',
        hypothesisId: 'hy_2',
      }).type,
    ).toBe('HYPOTHESIS');
  });

  it('rejects a FACT without evidence', () => {
    expect(FactEntry.safeParse({ ...fact, evidenceIds: [], quantities: [] }).success).toBe(false);
  });

  it('rejects a FACT quoting a number from evidence it does not cite', () => {
    expect(
      FactEntry.safeParse({
        ...fact,
        quantities: [
          { evidenceId: 'mt_db_pool_in_use_610000000', field: 'value', value: 30, unit: 'count' },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects an INFERENCE without premises or premised on itself', () => {
    const inf = {
      id: 'le_2',
      author: 'investigator',
      type: 'INFERENCE',
      statement: 's',
      rule: 'r',
    };
    expect(InferenceEntry.safeParse({ ...inf, premises: [] }).success).toBe(false);
    expect(InferenceEntry.safeParse({ ...inf, premises: ['le_2'] }).success).toBe(false);
  });

  it('rejects a FACT that smuggles in premises', () => {
    expect(LedgerEntry.safeParse({ ...fact, premises: ['le_9'] }).success).toBe(false);
  });
});

describe('hypotheses', () => {
  const prediction = {
    id: 'pr_1',
    statement: 'query execution p95 stays flat',
    check: 'compare_windows(query_exec_p95)',
    result: 'supported',
    evidenceIds: ['mt_db_query_exec_p95_605000000'],
    ledgerEntryIds: ['le_4'],
  };

  it('requires evidence for decided predictions', () => {
    const h = {
      id: 'hy_1',
      title: 'Pool exhaustion',
      statement: 's',
      predictions: [prediction],
      status: 'supported',
    };
    expect(Hypothesis.safeParse(h).success).toBe(true);
    expect(
      Hypothesis.safeParse({ ...h, predictions: [{ ...prediction, evidenceIds: [] }] }).success,
    ).toBe(false);
    expect(
      Hypothesis.safeParse({
        ...h,
        predictions: [{ ...prediction, result: 'pending', evidenceIds: [] }],
      }).success,
    ).toBe(true);
    expect(Hypothesis.safeParse({ ...h, predictions: [] }).success).toBe(false);
  });

  it('has no LLM confidence field', () => {
    const h = {
      id: 'hy_1',
      title: 't',
      statement: 's',
      predictions: [prediction],
      status: 'supported',
    };
    expect(Hypothesis.safeParse({ ...h, confidence: 0.9 }).success).toBe(false);
  });
});

describe('patches', () => {
  it('accepts every supported knob and revert', () => {
    for (const target of [
      'db.pool.capacity',
      'db.acquireTimeoutUs',
      'cache.capacity',
      'checkout.workers',
      'checkout.replicas',
      'checkout.memoryLimit',
      'checkout.cpuLimit',
      'api-gateway.timeoutUs',
      'orders-queue.consumers',
      'orders-queue.queueLimit',
    ]) {
      expect(Patch.safeParse({ target, to: 1 }).success, target).toBe(true);
    }
    expect(Patch.safeParse({ revert: 'ev_1' }).success).toBe(true);
  });

  it('rejects unknown targets and non-integer values', () => {
    expect(Patch.safeParse({ target: 'db.pool.size', to: 1 }).success).toBe(false);
    expect(Patch.safeParse({ target: 'checkout.threads', to: 1 }).success).toBe(false);
    expect(Patch.safeParse({ target: 'db.pool.capacity', to: 6.4 }).success).toBe(false);
    expect(Patch.safeParse({ target: 'db.pool.capacity', to: -1 }).success).toBe(false);
    expect(Patch.safeParse({ revert: 'lg_1' }).success).toBe(false);
  });

  it('parses and formats the CLI form', () => {
    expect(parsePatchArg('db.pool.capacity=64')).toEqual({ target: 'db.pool.capacity', to: 64 });
    expect(() => parsePatchArg('db.pool.capacity')).toThrow();
    expect(() => parsePatchArg('db.pool.capacity=')).toThrow();
    expect(() => parsePatchArg('db.pool.capacity=6.4')).toThrow();
    expect(() => parsePatchArg('nope=1')).toThrow();
    expect(formatPatch({ target: 'db.pool.capacity', from: 30, to: 64 })).toBe(
      'db.pool.capacity: 30 → 64',
    );
    expect(formatPatch({ revert: 'ev_1' })).toBe('revert ev_1');
  });
});

describe('diagnosis', () => {
  const diagnosis = {
    rootCause: {
      statement: 'DB connection pool exhaustion after checkout v2.4.1',
      ledgerEntryIds: ['le_1'],
    },
    causalChain: [{ statement: 'pool saturated', service: 'db', ledgerEntryIds: ['le_1'] }],
    affectedServices: ['checkout', 'api-gateway'],
    rejectedHypotheses: [
      {
        hypothesisId: 'hy_2',
        title: 'Slow DB',
        reason: 'query exec p95 flat',
        ledgerEntryIds: ['le_4'],
      },
    ],
    confidence: {
      score: 0.86,
      level: 'high',
      basis: {
        supportedPredictions: 3,
        contradictedPredictions: 0,
        inconclusivePredictions: 1,
        unresolvedContradictions: 0,
      },
    },
    unknowns: [],
    recommendations: [
      {
        id: 'rc_1',
        title: 'Raise pool capacity',
        rationale: 'pool is the saturated resource',
        patch: { target: 'db.pool.capacity', from: 30, to: 64 },
        ledgerEntryIds: ['le_1'],
      },
    ],
    unresolvedIssues: [],
  };

  it('accepts a well-formed diagnosis', () => {
    expect(Diagnosis.safeParse(diagnosis).success).toBe(true);
  });

  it('rejects uncited claims and out-of-range confidence', () => {
    expect(
      Diagnosis.safeParse({ ...diagnosis, rootCause: { statement: 's', ledgerEntryIds: [] } })
        .success,
    ).toBe(false);
    expect(
      Diagnosis.safeParse({ ...diagnosis, confidence: { ...diagnosis.confidence, score: 1.2 } })
        .success,
    ).toBe(false);
    expect(Diagnosis.safeParse({ ...diagnosis, causalChain: [] }).success).toBe(false);
  });
});
