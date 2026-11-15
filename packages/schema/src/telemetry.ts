import { z } from 'zod';
import { ChangeEventId, LogEvidenceId, PodEventId, ServiceName, SpanId, TraceId } from './ids.ts';
import { VirtualTimeUs } from './time.ts';

// OTel-shaped telemetry, in virtual time (brief §2). The simulator writes through these schemas
// exactly like a future real ingestor would.

export const AttributeValue = z.union([z.string(), z.number(), z.boolean()]);
export type AttributeValue = z.infer<typeof AttributeValue>;

export const Attributes = z.record(z.string().min(1), AttributeValue);
export type Attributes = z.infer<typeof Attributes>;

// ---- Spans ---------------------------------------------------------------------------------

export const SpanStatus = z.enum(['ok', 'error', 'timeout']);
export type SpanStatus = z.infer<typeof SpanStatus>;

/** Span names with explicit meaning. Their durations are what make waiting visible. */
export const SPAN_NAMES = {
  /** Duration = time spent WAITING for a DB connection. */
  poolAcquire: 'db.pool.acquire',
  /** Duration = query EXECUTION time (including any queueing at the DB executor). */
  dbQuery: 'db.query',
  /** Duration = time waiting in a service's request queue before a worker picks it up. */
  queueWait: 'queue.wait',
  /** Duration = time one pooled connection is HELD by a transaction (granted → released). */
  dbTransaction: 'db.transaction',
} as const;

/** Attribute keys the analyzers rely on. */
export const SPAN_ATTRS = {
  poolCapacity: 'db.pool.capacity',
  poolInUseAtAcquire: 'db.pool.in_use',
  poolWaitQueueAtAcquire: 'db.pool.wait_queue',
  dbActiveQueriesAtStart: 'db.active_queries',
  requestType: 'request.type',
  pod: 'k8s.pod.name',
  /** Statement or transaction name the connection/query is for. */
  dbStatement: 'db.statement',
  /** Part of a db.query span spent queued at the DB executor before execution started. */
  dbQueueWaitUs: 'db.queue_wait_us',
  httpStatus: 'http.status_code',
  /** External (non-modeled) dependency an outbound span talks to. */
  peerService: 'peer.service',
  /** true when the work was abandoned because the caller gave up. */
  cancelled: 'cancelled',
  /** 1-based attempt number on retried calls. */
  attempt: 'retry.attempt',
} as const;

export const Span = z
  .strictObject({
    traceId: TraceId,
    spanId: SpanId,
    /** null for a root span. */
    parentSpanId: SpanId.nullable(),
    service: ServiceName,
    name: z.string().min(1),
    startUs: VirtualTimeUs,
    endUs: VirtualTimeUs,
    status: SpanStatus,
    attributes: Attributes,
  })
  .refine((s) => s.endUs >= s.startUs, { message: 'endUs must be >= startUs', path: ['endUs'] })
  .refine((s) => s.parentSpanId !== s.spanId, {
    message: 'a span cannot be its own parent',
    path: ['parentSpanId'],
  });
export type Span = z.infer<typeof Span>;

// ---- Logs ----------------------------------------------------------------------------------

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export const LogRecord = z.strictObject({
  id: LogEvidenceId,
  ts: VirtualTimeUs,
  service: ServiceName,
  level: LogLevel,
  message: z.string().min(1),
  fields: Attributes,
  traceId: TraceId.optional(),
  spanId: SpanId.optional(),
});
export type LogRecord = z.infer<typeof LogRecord>;

// ---- Metrics -------------------------------------------------------------------------------

/**
 * Closed set of metric names (brief §2). Adding a metric is a deliberate schema change.
 * Units are fixed per name, see METRIC_UNITS.
 */
export const MetricName = z.enum([
  // per service
  'request_rate',
  'error_rate',
  'latency_p50',
  'latency_p95',
  'latency_p99',
  'in_flight',
  'queue_depth',
  // database / pool
  'pool_in_use',
  'pool_capacity',
  'pool_wait_queue',
  'query_exec_p95',
  'db_active_queries',
  // pod lifecycle (Scenario D)
  'replicas_ready',
  'pod_restarts',
  'memory_working_set',
  'cpu_throttled_ratio',
]);
export type MetricName = z.infer<typeof MetricName>;

export type MetricUnit = 'req/s' | 'ratio' | 'us' | 'count' | 'bytes';

export const METRIC_UNITS: Readonly<Record<MetricName, MetricUnit>> = {
  request_rate: 'req/s',
  error_rate: 'ratio',
  latency_p50: 'us',
  latency_p95: 'us',
  latency_p99: 'us',
  in_flight: 'count',
  queue_depth: 'count',
  pool_in_use: 'count',
  pool_capacity: 'count',
  pool_wait_queue: 'count',
  query_exec_p95: 'us',
  db_active_queries: 'count',
  replicas_ready: 'count',
  pod_restarts: 'count',
  memory_working_set: 'bytes',
  cpu_throttled_ratio: 'ratio',
};

export const MetricPoint = z
  .strictObject({
    ts: VirtualTimeUs,
    service: ServiceName,
    name: MetricName,
    /** Finite number (zod rejects NaN/Infinity). Unit given by METRIC_UNITS[name]. */
    value: z.number(),
    labels: z.record(z.string().min(1), z.string()),
  })
  .refine((p) => METRIC_UNITS[p.name] !== 'ratio' || (p.value >= 0 && p.value <= 1), {
    message: 'ratio metrics must be within [0, 1]',
    path: ['value'],
  })
  .refine((p) => METRIC_UNITS[p.name] === 'ratio' || p.value >= 0, {
    message: 'metric value must be non-negative',
    path: ['value'],
  });
export type MetricPoint = z.infer<typeof MetricPoint>;

// ---- Change events -------------------------------------------------------------------------

export const DiffValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type DiffValue = z.infer<typeof DiffValue>;

export const ChangeEventKind = z.enum(['deploy', 'config', 'rollout']);
export type ChangeEventKind = z.infer<typeof ChangeEventKind>;

export const ChangeEvent = z.strictObject({
  id: ChangeEventId,
  ts: VirtualTimeUs,
  kind: ChangeEventKind,
  service: ServiceName,
  description: z.string().min(1),
  diff: z.record(z.string().min(1), z.strictObject({ from: DiffValue, to: DiffValue })),
});
export type ChangeEvent = z.infer<typeof ChangeEvent>;

// ---- Pod events (Kubernetes-style, simulated only) ------------------------------------------

export const PodEventReason = z.enum([
  'Scheduled',
  'Started',
  'OOMKilled',
  'Restarted',
  'CrashLoopBackOff',
  'ReadinessFailed',
  'Evicted',
]);
export type PodEventReason = z.infer<typeof PodEventReason>;

export const PodEvent = z.strictObject({
  id: PodEventId,
  ts: VirtualTimeUs,
  service: ServiceName,
  pod: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'pod name must be lowercase kebab-case'),
  reason: PodEventReason,
  message: z.string().min(1),
});
export type PodEvent = z.infer<typeof PodEvent>;
