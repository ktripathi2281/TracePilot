// SQLite telemetry store and typed query API (brief §1, §2). This is the ONLY way agents and
// analyzers read telemetry.
//
// Information boundary (Phase 2 requirement): the store holds TELEMETRY ONLY. It has no table,
// column or function for simulator configuration, workloads, recordings, scenario names or ground
// truth, and incidents are identified by neutral IDs derived from a hash of their telemetry.
//
// Evidence IDs (`sp_…`, `lg_…`, `mt_…`, `ev_…`, `pe_…`) are unique within one incident. Two
// incidents (e.g. a recording and a replay of it) can contain the same IDs, so every lookup is
// scoped by incident.

import { createHash } from 'node:crypto';
import {
  ChangeEvent,
  IncidentId,
  LogRecord,
  MetricName,
  MetricPoint,
  PodEvent,
  Span,
  evidenceKind,
  metricEvidenceId,
  parseMetricEvidenceId,
  type EvidenceKind,
  type LogLevel,
  type SpanStatus,
} from '@tracepilot/schema';
import Database from 'better-sqlite3';
import { z } from 'zod';

/** The five telemetry streams, exactly as an ingestor receives them. */
export interface TelemetryBundle {
  spans: readonly Span[];
  logs: readonly LogRecord[];
  metrics: readonly MetricPoint[];
  changeEvents: readonly ChangeEvent[];
  podEvents: readonly PodEvent[];
}

export interface TelemetryCounts {
  spans: number;
  logs: number;
  metrics: number;
  changeEvents: number;
  podEvents: number;
}

/** What the store knows about an incident. Everything here is derived from its telemetry. */
export const Incident = z.strictObject({
  id: IncidentId,
  /** Where the telemetry came from. The demo only has `synthetic` (our simulator). */
  source: z.enum(['synthetic', 'external']),
  /** Earliest and latest timestamp seen in the telemetry (virtual µs). */
  startUs: z.number().int().nonnegative(),
  endUs: z.number().int().nonnegative(),
  /** Most common gap between consecutive samples of a metric series; null without metrics. */
  metricIntervalUs: z.number().int().positive().nullable(),
  services: z.array(z.string()),
  counts: z.strictObject({
    spans: z.number().int().nonnegative(),
    logs: z.number().int().nonnegative(),
    metrics: z.number().int().nonnegative(),
    changeEvents: z.number().int().nonnegative(),
    podEvents: z.number().int().nonnegative(),
  }),
  /** SHA-256 over the canonical telemetry (see hashBundle); the incident ID is derived from it. */
  telemetryHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Incident = z.infer<typeof Incident>;

export type Evidence =
  | { kind: 'span'; id: string; item: Span }
  | { kind: 'log'; id: string; item: LogRecord }
  | { kind: 'metric'; id: string; item: MetricPoint }
  | { kind: 'change'; id: string; item: ChangeEvent }
  | { kind: 'pod'; id: string; item: PodEvent };

export interface TimeRange {
  /** Inclusive. */
  fromUs?: number | undefined;
  /** Exclusive. */
  toUs?: number | undefined;
}

export interface SpanQuery extends TimeRange {
  service?: string | undefined;
  name?: string | undefined;
  status?: SpanStatus | undefined;
  /** Only root spans (no parent). */
  rootsOnly?: boolean | undefined;
  /** Which timestamp the range applies to. Default `start`. */
  timeField?: 'start' | 'end' | undefined;
  limit?: number | undefined;
}

export interface LogQuery extends TimeRange {
  service?: string | undefined;
  levels?: readonly LogLevel[] | undefined;
  /** Case-insensitive substring of the message. */
  contains?: string | undefined;
  traceId?: string | undefined;
  limit?: number | undefined;
}

export interface MetricQuery extends TimeRange {
  service: string;
  name: MetricName;
}

/** Canonical SHA-256 of a telemetry bundle, in emission order. */
export function hashBundle(t: TelemetryBundle): string {
  const h = createHash('sha256');
  for (const key of ['spans', 'logs', 'metrics', 'changeEvents', 'podEvents'] as const) {
    h.update(`#${key}\n`);
    for (const item of t[key]) {
      h.update(JSON.stringify(item));
      h.update('\n');
    }
  }
  return h.digest('hex');
}

/** Neutral incident ID: `in_` + 52 bits of the telemetry hash in base 36. Says nothing about content. */
export function incidentIdFor(telemetryHash: string): string {
  return `in_${BigInt(`0x${telemetryHash.slice(0, 13)}`).toString(36)}`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  metric_interval_us INTEGER,
  services TEXT NOT NULL,
  counts TEXT NOT NULL,
  telemetry_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS spans (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  seq INTEGER NOT NULL,
  span_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  status TEXT NOT NULL,
  attributes TEXT NOT NULL,
  PRIMARY KEY (incident_id, span_id)
);
CREATE INDEX IF NOT EXISTS spans_by_service ON spans (incident_id, service, name, start_us);
CREATE INDEX IF NOT EXISTS spans_by_trace ON spans (incident_id, trace_id);
CREATE INDEX IF NOT EXISTS spans_by_name ON spans (incident_id, name, start_us);
CREATE TABLE IF NOT EXISTS logs (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  service TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  fields TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  PRIMARY KEY (incident_id, id)
);
CREATE INDEX IF NOT EXISTS logs_by_time ON logs (incident_id, ts);
CREATE INDEX IF NOT EXISTS logs_by_trace ON logs (incident_id, trace_id);
CREATE TABLE IF NOT EXISTS metrics (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  seq INTEGER NOT NULL,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  labels TEXT NOT NULL,
  PRIMARY KEY (incident_id, service, name, ts)
);
CREATE TABLE IF NOT EXISTS change_events (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  service TEXT NOT NULL,
  description TEXT NOT NULL,
  diff TEXT NOT NULL,
  PRIMARY KEY (incident_id, id)
);
CREATE TABLE IF NOT EXISTS pod_events (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  service TEXT NOT NULL,
  pod TEXT NOT NULL,
  reason TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (incident_id, id)
);
`;

// ---- Row shapes (as stored) ------------------------------------------------------------------

const SpanRow = z.strictObject({
  span_id: z.string(),
  trace_id: z.string(),
  parent_span_id: z.string().nullable(),
  service: z.string(),
  name: z.string(),
  start_us: z.number(),
  end_us: z.number(),
  status: z.string(),
  attributes: z.string(),
});
const LogRow = z.strictObject({
  id: z.string(),
  ts: z.number(),
  service: z.string(),
  level: z.string(),
  message: z.string(),
  fields: z.string(),
  trace_id: z.string().nullable(),
  span_id: z.string().nullable(),
});
const MetricRow = z.strictObject({
  service: z.string(),
  name: z.string(),
  ts: z.number(),
  value: z.number(),
  labels: z.string(),
});
const ChangeRow = z.strictObject({
  id: z.string(),
  ts: z.number(),
  kind: z.string(),
  service: z.string(),
  description: z.string(),
  diff: z.string(),
});
const PodRow = z.strictObject({
  id: z.string(),
  ts: z.number(),
  service: z.string(),
  pod: z.string(),
  reason: z.string(),
  message: z.string(),
});
const IncidentRow = z.strictObject({
  id: z.string(),
  source: z.string(),
  start_us: z.number(),
  end_us: z.number(),
  metric_interval_us: z.number().nullable(),
  services: z.string(),
  counts: z.string(),
  telemetry_hash: z.string(),
});

const json = (s: string): unknown => JSON.parse(s);

// Rows are re-validated through the telemetry schemas on the way out: the store is a boundary.
function toSpan(r: z.infer<typeof SpanRow>): Span {
  return Span.parse({
    traceId: r.trace_id,
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    service: r.service,
    name: r.name,
    startUs: r.start_us,
    endUs: r.end_us,
    status: r.status,
    attributes: json(r.attributes),
  });
}
function toLog(r: z.infer<typeof LogRow>): LogRecord {
  const raw: Record<string, unknown> = {
    id: r.id,
    ts: r.ts,
    service: r.service,
    level: r.level,
    message: r.message,
    fields: json(r.fields),
  };
  if (r.trace_id !== null) raw['traceId'] = r.trace_id;
  if (r.span_id !== null) raw['spanId'] = r.span_id;
  return LogRecord.parse(raw);
}
function toMetric(r: z.infer<typeof MetricRow>): MetricPoint {
  return MetricPoint.parse({
    ts: r.ts,
    service: r.service,
    name: r.name,
    value: r.value,
    labels: json(r.labels),
  });
}
function toChange(r: z.infer<typeof ChangeRow>): ChangeEvent {
  return ChangeEvent.parse({
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    service: r.service,
    description: r.description,
    diff: json(r.diff),
  });
}
function toPod(r: z.infer<typeof PodRow>): PodEvent {
  return PodEvent.parse({
    id: r.id,
    ts: r.ts,
    service: r.service,
    pod: r.pod,
    reason: r.reason,
    message: r.message,
  });
}
function toIncident(r: z.infer<typeof IncidentRow>): Incident {
  return Incident.parse({
    id: r.id,
    source: r.source,
    startUs: r.start_us,
    endUs: r.end_us,
    metricIntervalUs: r.metric_interval_us,
    services: json(r.services),
    counts: json(r.counts),
    telemetryHash: r.telemetry_hash,
  });
}

const SPAN_COLS =
  'span_id, trace_id, parent_span_id, service, name, start_us, end_us, status, attributes';
const LOG_COLS = 'id, ts, service, level, message, fields, trace_id, span_id';
const METRIC_COLS = 'service, name, ts, value, labels';
const CHANGE_COLS = 'id, ts, kind, service, description, diff';
const POD_COLS = 'id, ts, service, pod, reason, message';

function mostCommonGap(metrics: readonly MetricPoint[]): number | null {
  const last = new Map<string, number>();
  const gaps = new Map<number, number>();
  for (const m of metrics) {
    const key = `${m.service}|${m.name}`;
    const prev = last.get(key);
    if (prev !== undefined && m.ts > prev) gaps.set(m.ts - prev, (gaps.get(m.ts - prev) ?? 0) + 1);
    last.set(key, m.ts);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [gap, count] of gaps) {
    if (count > bestCount || (count === bestCount && best !== null && gap < best)) {
      best = gap;
      bestCount = count;
    }
  }
  return best;
}

export interface IngestOptions {
  source?: 'synthetic' | 'external';
}

export interface IngestResult {
  incident: Incident;
  /** False when identical telemetry was already stored; the existing incident is returned. */
  created: boolean;
}

export class TelemetryStore {
  private readonly db: Database.Database;

  /** Opens (and creates if needed) a store. `:memory:` gives a throwaway store. */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ---- Ingest ---------------------------------------------------------------------------------

  /**
   * Validates every item through its schema (exactly like a real ingestor would, brief §2) and
   * stores it under a neutral incident ID. Rejects the whole bundle on the first invalid item or
   * duplicate evidence ID; nothing is written in that case.
   */
  ingest(bundle: TelemetryBundle, options: IngestOptions = {}): IngestResult {
    const spans = bundle.spans.map((s, i) => parseOrThrow(Span, s, `span #${String(i)}`));
    const logs = bundle.logs.map((l, i) => parseOrThrow(LogRecord, l, `log #${String(i)}`));
    const metrics = bundle.metrics.map((m, i) =>
      parseOrThrow(MetricPoint, m, `metric #${String(i)}`),
    );
    const changeEvents = bundle.changeEvents.map((c, i) =>
      parseOrThrow(ChangeEvent, c, `change event #${String(i)}`),
    );
    const podEvents = bundle.podEvents.map((p, i) =>
      parseOrThrow(PodEvent, p, `pod event #${String(i)}`),
    );
    const validated: TelemetryBundle = { spans, logs, metrics, changeEvents, podEvents };

    const telemetryHash = hashBundle(validated);
    const existing = this.db
      .prepare('SELECT * FROM incidents WHERE telemetry_hash = ?')
      .get(telemetryHash);
    if (existing !== undefined)
      return { incident: toIncident(IncidentRow.parse(existing)), created: false };

    let startUs = Number.MAX_SAFE_INTEGER;
    let endUs = 0;
    const seeTime = (t: number): void => {
      if (t < startUs) startUs = t;
      if (t > endUs) endUs = t;
    };
    const services = new Set<string>();
    for (const s of spans) {
      seeTime(s.startUs);
      seeTime(s.endUs);
      services.add(s.service);
    }
    for (const l of logs) seeTime(l.ts);
    for (const m of metrics) {
      seeTime(m.ts);
      services.add(m.service);
    }
    for (const c of changeEvents) seeTime(c.ts);
    for (const p of podEvents) seeTime(p.ts);
    if (startUs === Number.MAX_SAFE_INTEGER) startUs = 0;
    // Telemetry starts at the beginning of the first metric window, not at its first sample.
    const metricIntervalUs = mostCommonGap(metrics);
    if (metrics.length > 0 && metricIntervalUs !== null) {
      startUs = Math.max(0, Math.min(startUs, (metrics[0]?.ts ?? 0) - metricIntervalUs));
    }

    const incident: Incident = Incident.parse({
      id: incidentIdFor(telemetryHash),
      source: options.source ?? 'synthetic',
      startUs,
      endUs,
      metricIntervalUs,
      services: [...services].sort(),
      counts: {
        spans: spans.length,
        logs: logs.length,
        metrics: metrics.length,
        changeEvents: changeEvents.length,
        podEvents: podEvents.length,
      },
      telemetryHash,
    });

    const insertIncident = this.db.prepare(
      'INSERT INTO incidents VALUES (@id, @source, @startUs, @endUs, @metricIntervalUs, @services, @counts, @telemetryHash)',
    );
    const insertSpan = this.db.prepare(`INSERT INTO spans VALUES (?, ?, ${'?, '.repeat(8)}?)`);
    const insertLog = this.db.prepare(`INSERT INTO logs VALUES (?, ?, ${'?, '.repeat(7)}?)`);
    const insertMetric = this.db.prepare(`INSERT INTO metrics VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertChange = this.db.prepare(
      `INSERT INTO change_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPod = this.db.prepare(`INSERT INTO pod_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const id = incident.id;

    this.db.transaction(() => {
      insertIncident.run({
        ...incident,
        services: JSON.stringify(incident.services),
        counts: JSON.stringify(incident.counts),
      });
      spans.forEach((s, i) => {
        insertSpan.run(
          id,
          i,
          s.spanId,
          s.traceId,
          s.parentSpanId,
          s.service,
          s.name,
          s.startUs,
          s.endUs,
          s.status,
          JSON.stringify(s.attributes),
        );
      });
      logs.forEach((l, i) => {
        insertLog.run(
          id,
          i,
          l.id,
          l.ts,
          l.service,
          l.level,
          l.message,
          JSON.stringify(l.fields),
          l.traceId ?? null,
          l.spanId ?? null,
        );
      });
      metrics.forEach((m, i) => {
        insertMetric.run(id, i, m.service, m.name, m.ts, m.value, JSON.stringify(m.labels));
      });
      changeEvents.forEach((c, i) => {
        insertChange.run(
          id,
          i,
          c.id,
          c.ts,
          c.kind,
          c.service,
          c.description,
          JSON.stringify(c.diff),
        );
      });
      podEvents.forEach((p, i) => {
        insertPod.run(id, i, p.id, p.ts, p.service, p.pod, p.reason, p.message);
      });
    })();
    return { incident, created: true };
  }

  // ---- Incidents ------------------------------------------------------------------------------

  listIncidents(): Incident[] {
    return this.db
      .prepare('SELECT * FROM incidents ORDER BY id')
      .all()
      .map((r) => toIncident(IncidentRow.parse(r)));
  }

  getIncident(incidentId: string): Incident {
    const row = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
    if (row === undefined) throw new Error(`unknown incident ${incidentId}`);
    return toIncident(IncidentRow.parse(row));
  }

  // ---- Metrics --------------------------------------------------------------------------------

  /** Every (service, metric) series in the incident with its sample count. */
  listMetricSeries(incidentId: string): { service: string; name: MetricName; points: number }[] {
    this.getIncident(incidentId);
    const rows = this.db
      .prepare(
        'SELECT service, name, COUNT(*) AS points FROM metrics WHERE incident_id = ? GROUP BY service, name ORDER BY service, name',
      )
      .all(incidentId);
    return rows.map((r) =>
      z.strictObject({ service: z.string(), name: MetricName, points: z.number() }).parse(r),
    );
  }

  /** One series, time-ordered, ts in [fromUs, toUs). */
  getMetricSeries(incidentId: string, q: MetricQuery): MetricPoint[] {
    this.getIncident(incidentId);
    const rows = this.db
      .prepare(
        `SELECT ${METRIC_COLS} FROM metrics WHERE incident_id = ? AND service = ? AND name = ? AND ts >= ? AND ts < ? ORDER BY ts`,
      )
      .all(incidentId, q.service, q.name, q.fromUs ?? 0, q.toUs ?? Number.MAX_SAFE_INTEGER);
    return rows.map((r) => toMetric(MetricRow.parse(r)));
  }

  /** All metric points (optionally of one service), in emission order. */
  getMetrics(incidentId: string, q: TimeRange & { service?: string } = {}): MetricPoint[] {
    this.getIncident(incidentId);
    const rows = this.db
      .prepare(
        `SELECT ${METRIC_COLS} FROM metrics WHERE incident_id = ? AND (? IS NULL OR service = ?) AND ts >= ? AND ts < ? ORDER BY seq`,
      )
      .all(
        incidentId,
        q.service ?? null,
        q.service ?? null,
        q.fromUs ?? 0,
        q.toUs ?? Number.MAX_SAFE_INTEGER,
      );
    return rows.map((r) => toMetric(MetricRow.parse(r)));
  }

  // ---- Spans ----------------------------------------------------------------------------------

  /** Spans matching the query, ordered by the chosen time field. */
  getSpans(incidentId: string, q: SpanQuery = {}): Span[] {
    this.getIncident(incidentId);
    const timeCol = q.timeField === 'end' ? 'end_us' : 'start_us';
    const rows = this.db
      .prepare(
        `SELECT ${SPAN_COLS} FROM spans WHERE incident_id = ?
           AND (? IS NULL OR service = ?) AND (? IS NULL OR name = ?) AND (? IS NULL OR status = ?)
           AND (? = 0 OR parent_span_id IS NULL)
           AND ${timeCol} >= ? AND ${timeCol} < ?
         ORDER BY ${timeCol}, seq LIMIT ?`,
      )
      .all(
        incidentId,
        q.service ?? null,
        q.service ?? null,
        q.name ?? null,
        q.name ?? null,
        q.status ?? null,
        q.status ?? null,
        q.rootsOnly === true ? 1 : 0,
        q.fromUs ?? 0,
        q.toUs ?? Number.MAX_SAFE_INTEGER,
        q.limit ?? -1,
      );
    return rows.map((r) => toSpan(SpanRow.parse(r)));
  }

  /** All spans of one trace, ordered by start time. Empty if the trace is unknown. */
  getTrace(incidentId: string, traceId: string): Span[] {
    this.getIncident(incidentId);
    return this.db
      .prepare(
        `SELECT ${SPAN_COLS} FROM spans WHERE incident_id = ? AND trace_id = ? ORDER BY start_us, seq`,
      )
      .all(incidentId, traceId)
      .map((r) => toSpan(SpanRow.parse(r)));
  }

  /**
   * All spans of every trace whose ROOT span starts in [fromUs, toUs), grouped by trace and
   * ordered by root start. Optionally only traces whose root is in `rootService`.
   */
  getTracesByRootStart(
    incidentId: string,
    q: TimeRange & { rootService?: string; rootName?: string },
  ): Span[][] {
    this.getIncident(incidentId);
    const rows = this.db
      .prepare(
        `SELECT ${SPAN_COLS.split(', ')
          .map((c) => `s.${c}`)
          .join(', ')} FROM spans s
           JOIN spans r ON r.incident_id = s.incident_id AND r.trace_id = s.trace_id AND r.parent_span_id IS NULL
         WHERE s.incident_id = ? AND r.start_us >= ? AND r.start_us < ?
           AND (? IS NULL OR r.service = ?) AND (? IS NULL OR r.name = ?)
         ORDER BY r.start_us, r.seq, s.start_us, s.seq`,
      )
      .all(
        incidentId,
        q.fromUs ?? 0,
        q.toUs ?? Number.MAX_SAFE_INTEGER,
        q.rootService ?? null,
        q.rootService ?? null,
        q.rootName ?? null,
        q.rootName ?? null,
      );
    const traces: Span[][] = [];
    let current: Span[] | undefined;
    for (const r of rows) {
      const span = toSpan(SpanRow.parse(r));
      if (current === undefined || current[0]?.traceId !== span.traceId) {
        current = [];
        traces.push(current);
      }
      current.push(span);
    }
    return traces;
  }

  // ---- Logs -----------------------------------------------------------------------------------

  searchLogs(incidentId: string, q: LogQuery = {}): LogRecord[] {
    this.getIncident(incidentId);
    const levels = q.levels ?? null;
    const rows = this.db
      .prepare(
        `SELECT ${LOG_COLS} FROM logs WHERE incident_id = ?
           AND (? IS NULL OR service = ?)
           AND (? IS NULL OR level IN (SELECT value FROM json_each(?)))
           AND (? IS NULL OR instr(lower(message), lower(?)) > 0)
           AND (? IS NULL OR trace_id = ?)
           AND ts >= ? AND ts < ?
         ORDER BY ts, seq LIMIT ?`,
      )
      .all(
        incidentId,
        q.service ?? null,
        q.service ?? null,
        levels === null ? null : 1,
        levels === null ? null : JSON.stringify(levels),
        q.contains ?? null,
        q.contains ?? null,
        q.traceId ?? null,
        q.traceId ?? null,
        q.fromUs ?? 0,
        q.toUs ?? Number.MAX_SAFE_INTEGER,
        q.limit ?? -1,
      );
    return rows.map((r) => toLog(LogRow.parse(r)));
  }

  // ---- Events ---------------------------------------------------------------------------------

  listChangeEvents(incidentId: string, q: TimeRange = {}): ChangeEvent[] {
    this.getIncident(incidentId);
    return this.db
      .prepare(
        `SELECT ${CHANGE_COLS} FROM change_events WHERE incident_id = ? AND ts >= ? AND ts < ? ORDER BY ts, seq`,
      )
      .all(incidentId, q.fromUs ?? 0, q.toUs ?? Number.MAX_SAFE_INTEGER)
      .map((r) => toChange(ChangeRow.parse(r)));
  }

  listPodEvents(incidentId: string, q: TimeRange = {}): PodEvent[] {
    this.getIncident(incidentId);
    return this.db
      .prepare(
        `SELECT ${POD_COLS} FROM pod_events WHERE incident_id = ? AND ts >= ? AND ts < ? ORDER BY ts, seq`,
      )
      .all(incidentId, q.fromUs ?? 0, q.toUs ?? Number.MAX_SAFE_INTEGER)
      .map((r) => toPod(PodRow.parse(r)));
  }

  // ---- Evidence -------------------------------------------------------------------------------

  /** Resolves an evidence ID within an incident. Returns undefined when it does not exist. */
  getEvidence(incidentId: string, evidenceId: string): Evidence | undefined {
    this.getIncident(incidentId);
    const kind: EvidenceKind | undefined = evidenceKind(evidenceId);
    switch (kind) {
      case undefined:
        return undefined;
      case 'span': {
        const row = this.db
          .prepare(`SELECT ${SPAN_COLS} FROM spans WHERE incident_id = ? AND span_id = ?`)
          .get(incidentId, evidenceId.slice(3));
        return row === undefined
          ? undefined
          : { kind, id: evidenceId, item: toSpan(SpanRow.parse(row)) };
      }
      case 'log': {
        const row = this.db
          .prepare(`SELECT ${LOG_COLS} FROM logs WHERE incident_id = ? AND id = ?`)
          .get(incidentId, evidenceId);
        return row === undefined
          ? undefined
          : { kind, id: evidenceId, item: toLog(LogRow.parse(row)) };
      }
      case 'metric': {
        const parsed = parseMetricEvidenceId(evidenceId);
        if (parsed === undefined) return undefined;
        const row = this.db
          .prepare(
            `SELECT ${METRIC_COLS} FROM metrics WHERE incident_id = ? AND service = ? AND name = ? AND ts = ?`,
          )
          .get(incidentId, parsed.service, parsed.metric, parsed.ts);
        if (row === undefined) return undefined;
        const item = toMetric(MetricRow.parse(row));
        // IDs are canonical: reject e.g. leading zeros in the timestamp.
        if (metricEvidenceId(item.service, item.name, item.ts) !== evidenceId) return undefined;
        return { kind, id: evidenceId, item };
      }
      case 'change': {
        const row = this.db
          .prepare(`SELECT ${CHANGE_COLS} FROM change_events WHERE incident_id = ? AND id = ?`)
          .get(incidentId, evidenceId);
        return row === undefined
          ? undefined
          : { kind, id: evidenceId, item: toChange(ChangeRow.parse(row)) };
      }
      case 'pod': {
        const row = this.db
          .prepare(`SELECT ${POD_COLS} FROM pod_events WHERE incident_id = ? AND id = ?`)
          .get(incidentId, evidenceId);
        return row === undefined
          ? undefined
          : { kind, id: evidenceId, item: toPod(PodRow.parse(row)) };
      }
    }
  }

  /** Every stored item of an incident, in ingest order. `hashBundle` of it equals the incident hash. */
  exportTelemetry(incidentId: string): TelemetryBundle {
    this.getIncident(incidentId);
    const all = <T>(sql: string, map: (r: unknown) => T): T[] =>
      this.db.prepare(sql).all(incidentId).map(map);
    return {
      spans: all(`SELECT ${SPAN_COLS} FROM spans WHERE incident_id = ? ORDER BY seq`, (r) =>
        toSpan(SpanRow.parse(r)),
      ),
      logs: all(`SELECT ${LOG_COLS} FROM logs WHERE incident_id = ? ORDER BY seq`, (r) =>
        toLog(LogRow.parse(r)),
      ),
      metrics: all(`SELECT ${METRIC_COLS} FROM metrics WHERE incident_id = ? ORDER BY seq`, (r) =>
        toMetric(MetricRow.parse(r)),
      ),
      changeEvents: all(
        `SELECT ${CHANGE_COLS} FROM change_events WHERE incident_id = ? ORDER BY seq`,
        (r) => toChange(ChangeRow.parse(r)),
      ),
      podEvents: all(`SELECT ${POD_COLS} FROM pod_events WHERE incident_id = ? ORDER BY seq`, (r) =>
        toPod(PodRow.parse(r)),
      ),
    };
  }

  /** Table and column names, for the information-boundary test. */
  describeSchema(): { table: string; columns: string[] }[] {
    const tables = z
      .array(z.object({ name: z.string() }))
      .parse(
        this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      );
    return tables.map(({ name }) => ({
      table: name,
      columns: z
        .array(z.object({ name: z.string() }))
        .parse(this.db.prepare(`PRAGMA table_info(${name})`).all())
        .map((c) => c.name),
    }));
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `invalid ${what}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}
