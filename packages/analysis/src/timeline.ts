// Timeline builder (brief §4.1): change events, pod events, metric anomalies (onset and recovery),
// error-log bursts and span-level onsets on one ordered axis. Every entry cites evidence.

import type { ChangeEvent, PodEvent } from '@tracepilot/schema';
import type { Anomaly } from './anomaly.ts';
import type { LogBurst } from './logs.ts';
import type { OnsetEstimate } from './precedence.ts';

export type TimelineKind =
  'change' | 'pod_event' | 'span_onset' | 'anomaly_onset' | 'log_burst' | 'anomaly_recovered';

export interface TimelineEntry {
  ts: number;
  kind: TimelineKind;
  service: string;
  summary: string;
  /** For anomalies: whether it was still ongoing at the end of the data. */
  status?: 'ongoing' | 'recovered';
  evidenceIds: string[];
}

export interface TimelineInput {
  changes?: readonly ChangeEvent[];
  /** Pod events that take pods out of service or bring them back (Started is left out). */
  podEvents?: readonly PodEvent[];
  anomalies?: readonly Anomaly[];
  logBursts?: readonly LogBurst[];
  spanOnsets?: readonly OnsetEstimate[];
}

const ORDER: Record<TimelineKind, number> = {
  change: 0,
  pod_event: 1,
  span_onset: 1,
  anomaly_onset: 2,
  log_burst: 3,
  anomaly_recovered: 4,
};

const fmtValue = (a: Anomaly, v: number): string =>
  a.unit === 'us'
    ? `${(v / 1000).toFixed(1)}ms`
    : a.unit === 'ratio'
      ? `${(v * 100).toFixed(1)}%`
      : String(v);

export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const c of input.changes ?? []) {
    out.push({
      ts: c.ts,
      kind: 'change',
      service: c.service,
      summary: `${c.kind}: ${c.description}`,
      evidenceIds: [c.id],
    });
  }
  for (const p of input.podEvents ?? []) {
    if (p.reason === 'Started' || p.reason === 'Scheduled') continue;
    out.push({
      ts: p.ts,
      kind: 'pod_event',
      service: p.service,
      summary: `${p.pod} ${p.reason}`,
      evidenceIds: [p.id],
    });
  }
  for (const a of input.anomalies ?? []) {
    out.push({
      ts: a.onsetUs,
      kind: 'anomaly_onset',
      service: a.service,
      summary: `${a.metric} ${a.direction}: ${fmtValue(a, a.baseline.median)} → ${fmtValue(a, a.value.median)}`,
      status: a.status,
      evidenceIds: a.evidenceIds,
    });
    if (a.endUs !== null) {
      out.push({
        ts: a.endUs,
        kind: 'anomaly_recovered',
        service: a.service,
        summary: `${a.metric} back within baseline`,
        status: 'recovered',
        evidenceIds: a.evidenceIds.slice(-1),
      });
    }
  }
  for (const b of input.logBursts ?? []) {
    out.push({
      ts: b.startUs,
      kind: 'log_burst',
      service: b.service,
      summary: `${String(b.count)} × ${b.level} "${b.template}"`,
      status: b.endUs === null ? 'ongoing' : 'recovered',
      evidenceIds: b.evidenceIds,
    });
  }
  for (const s of input.spanOnsets ?? []) {
    out.push({
      ts: s.ts,
      kind: 'span_onset',
      service: s.service,
      summary: s.label,
      evidenceIds: s.evidenceIds,
    });
  }
  return out.sort(
    (x, y) =>
      x.ts - y.ts ||
      ORDER[x.kind] - ORDER[y.kind] ||
      (x.service < y.service ? -1 : x.service > y.service ? 1 : 0) ||
      (x.summary < y.summary ? -1 : x.summary > y.summary ? 1 : 0),
  );
}
