import { z } from 'zod';
import { VirtualTimeUs } from './time.ts';

// ---- Names ---------------------------------------------------------------------------------

/**
 * Service names are lowercase kebab-case with NO underscores. This keeps metric evidence IDs
 * (`mt_<service>_<metric>_<ts>`) unambiguous to parse: the first `_` after `mt_` ends the service.
 */
export const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*$/;
export const ServiceName = z
  .string()
  .regex(SERVICE_NAME_RE, 'service name must be lowercase kebab-case (no underscores)');
export type ServiceName = z.infer<typeof ServiceName>;

/** Metric names are lowercase snake_case. */
export const METRIC_NAME_RE = /^[a-z][a-z0-9_]*$/;

// ---- OpenTelemetry-shaped IDs ----------------------------------------------------------------

/** 128-bit trace id as 32 lowercase hex chars (OTel). */
export const TraceId = z.string().regex(/^[0-9a-f]{32}$/, 'traceId must be 32 lowercase hex chars');
export type TraceId = z.infer<typeof TraceId>;

/** 64-bit span id as 16 lowercase hex chars (OTel). */
export const SpanId = z.string().regex(/^[0-9a-f]{16}$/, 'spanId must be 16 lowercase hex chars');
export type SpanId = z.infer<typeof SpanId>;

// ---- Evidence IDs (brief §2) ---------------------------------------------------------------
// Every stored item has a stable ID that agents cite. The verifier resolves these against the store.

const opaque = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-z]+$`), `must look like ${prefix}_<base36>`);

export const SpanEvidenceId = z.string().regex(/^sp_[0-9a-f]{16}$/, 'must look like sp_<spanId>');
export const LogEvidenceId = opaque('lg');
export const METRIC_EVIDENCE_ID_RE = /^mt_([a-z][a-z0-9-]*)_([a-z][a-z0-9_]*)_(\d+)$/;
export const MetricEvidenceId = z
  .string()
  .regex(METRIC_EVIDENCE_ID_RE, 'must look like mt_<service>_<metric>_<ts>');
export const ChangeEventId = opaque('ev');
export const PodEventId = opaque('pe');

export type SpanEvidenceId = z.infer<typeof SpanEvidenceId>;
export type LogEvidenceId = z.infer<typeof LogEvidenceId>;
export type MetricEvidenceId = z.infer<typeof MetricEvidenceId>;
export type ChangeEventId = z.infer<typeof ChangeEventId>;
export type PodEventId = z.infer<typeof PodEventId>;

export const EvidenceId = z.union([
  SpanEvidenceId,
  LogEvidenceId,
  MetricEvidenceId,
  ChangeEventId,
  PodEventId,
]);
export type EvidenceId = z.infer<typeof EvidenceId>;

export type EvidenceKind = 'span' | 'log' | 'metric' | 'change' | 'pod';

const KIND_BY_PREFIX: Readonly<Record<string, EvidenceKind>> = {
  sp: 'span',
  lg: 'log',
  mt: 'metric',
  ev: 'change',
  pe: 'pod',
};

/** Returns the evidence kind of a well-formed evidence ID, or undefined if it is malformed. */
export function evidenceKind(id: string): EvidenceKind | undefined {
  if (!EvidenceId.safeParse(id).success) return undefined;
  return KIND_BY_PREFIX[id.slice(0, 2)];
}

export function spanEvidenceId(spanId: SpanId): SpanEvidenceId {
  return SpanEvidenceId.parse(`sp_${SpanId.parse(spanId)}`);
}

export function metricEvidenceId(service: string, metric: string, ts: number): MetricEvidenceId {
  const svc = ServiceName.parse(service);
  if (!METRIC_NAME_RE.test(metric)) throw new Error(`invalid metric name: ${metric}`);
  const t = VirtualTimeUs.parse(ts);
  return `mt_${svc}_${metric}_${String(t)}`;
}

export interface ParsedMetricEvidenceId {
  service: ServiceName;
  metric: string;
  ts: VirtualTimeUs;
}

export function parseMetricEvidenceId(id: string): ParsedMetricEvidenceId | undefined {
  const m = METRIC_EVIDENCE_ID_RE.exec(id);
  if (m === null) return undefined;
  const [, service, metric, ts] = m;
  if (service === undefined || metric === undefined || ts === undefined) return undefined;
  const parsedTs = Number(ts);
  if (!Number.isSafeInteger(parsedTs)) return undefined;
  return { service, metric, ts: parsedTs };
}

// ---- Non-evidence IDs used by the agent layer ----------------------------------------------

export const LedgerEntryId = opaque('le');
export const HypothesisId = opaque('hy');
export const PredictionId = opaque('pr');
export const RecommendationId = opaque('rc');
export const IncidentId = opaque('in');

export type LedgerEntryId = z.infer<typeof LedgerEntryId>;
export type HypothesisId = z.infer<typeof HypothesisId>;
export type PredictionId = z.infer<typeof PredictionId>;
export type RecommendationId = z.infer<typeof RecommendationId>;
export type IncidentId = z.infer<typeof IncidentId>;
