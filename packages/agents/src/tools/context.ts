// Per-investigation tool context: the store, one incident, and memoized analysis results.
//
// Everything here reads through TelemetryStore. There is no path from this file to simulator
// configuration or ground truth (lint: packages/agents may not import sim or eval).

import {
  buildDependencyGraph,
  buildTraces,
  detectLogBursts,
  inferIncidentWindows,
  refineOnsetsFromSpans,
  scanAnomalies,
  toSeries,
  type AnomalyScan,
  type IncidentWindows,
  type LogBurst,
  type RefinedOnsets,
  type Series,
  type TraceTree,
  type Window,
} from '@tracepilot/analysis';
import type { ChangeEvent, DependencyGraph, MetricPoint, Span } from '@tracepilot/schema';
import type { Incident, TelemetryStore } from '@tracepilot/store';
import { z } from 'zod';

export const WindowArg = z.union([
  z.enum(['baseline', 'incident']),
  z.strictObject({ fromUs: z.number().int().nonnegative(), toUs: z.number().int().positive() }),
]);
export type WindowArg = z.infer<typeof WindowArg>;

export interface ResolvedWindow {
  window: Window;
  /** Used in finding keys: `baseline`, `incident` or `<from>-<to>`. */
  label: string;
}

export class ToolContext {
  readonly incident: Incident;
  readonly tick: number;
  private readonly cache = new Map<string, unknown>();

  readonly store: TelemetryStore;
  readonly incidentId: string;

  constructor(store: TelemetryStore, incidentId: string) {
    this.store = store;
    this.incidentId = incidentId;
    this.incident = store.getIncident(incidentId);
    if (this.incident.metricIntervalUs === null) {
      throw new Error(`incident ${incidentId} has no metrics; nothing to analyze`);
    }
    this.tick = this.incident.metricIntervalUs;
  }

  private memo<T>(key: string, compute: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, compute());
    return this.cache.get(key) as T;
  }

  get metrics(): MetricPoint[] {
    return this.memo('metrics', () => this.store.getMetrics(this.incidentId));
  }
  get series(): Series[] {
    return this.memo('series', () => toSeries(this.metrics));
  }
  get spans(): Span[] {
    return this.memo('spans', () => this.store.getSpans(this.incidentId));
  }
  get graph(): DependencyGraph {
    return this.memo('graph', () => buildDependencyGraph(this.spans));
  }
  get changes(): ChangeEvent[] {
    return this.memo('changes', () => this.store.listChangeEvents(this.incidentId));
  }

  /** Symptom and windows inferred from telemetry; null when no user-facing symptom was found. */
  get inferred(): IncidentWindows | null {
    return this.memo('inferred', () =>
      inferIncidentWindows(this.series, {
        range: { fromUs: this.incident.startUs, toUs: this.incident.endUs },
        entryServices: this.graph.entryServices,
      }),
    );
  }

  /**
   * Baseline and incident windows. Without a symptom there is no incident to speak of: the first
   * half of the data (after warm-up) stands in as baseline and the second half as "incident" so
   * tools still answer, and get_incident_window says that no symptom was found.
   */
  get windows(): { baseline: Window; incident: Window; scanFromUs: number } {
    const w = this.inferred;
    if (w !== null) return { baseline: w.baseline, incident: w.incident, scanFromUs: w.scanFromUs };
    const from = this.incident.startUs + 60_000_000;
    const mid = Math.floor((from + this.incident.endUs) / 2);
    return {
      baseline: { fromUs: from, toUs: mid },
      incident: { fromUs: mid, toUs: this.incident.endUs + 1 },
      scanFromUs: from,
    };
  }

  resolveWindow(arg: WindowArg): ResolvedWindow {
    if (arg === 'baseline') return { window: this.windows.baseline, label: 'baseline' };
    if (arg === 'incident') return { window: this.windows.incident, label: 'incident' };
    if (arg.toUs <= arg.fromUs) throw new Error('window.toUs must be greater than window.fromUs');
    return { window: arg, label: `${String(arg.fromUs)}-${String(arg.toUs)}` };
  }

  get anomalies(): AnomalyScan {
    return this.memo('anomalies', () =>
      scanAnomalies(this.series, {
        baseline: this.windows.baseline,
        scanFromUs: this.windows.scanFromUs,
      }),
    );
  }

  get refined(): RefinedOnsets {
    return this.memo('refined', () =>
      refineOnsetsFromSpans(this.spans, {
        baseline: this.windows.baseline,
        fromUs: this.windows.baseline.toUs,
        windowUs: this.tick,
      }),
    );
  }

  get logBursts(): LogBurst[] {
    return this.memo('logBursts', () =>
      detectLogBursts(this.store.searchLogs(this.incidentId, { levels: ['warn', 'error'] }), {
        baseline: this.windows.baseline,
        bucketUs: this.tick,
      }),
    );
  }

  /** Complete traces whose root span starts in the window, optionally of one root operation. */
  tracesIn(w: ResolvedWindow, route?: string): TraceTree[] {
    return this.memo(`traces|${w.label}|${route ?? '*'}`, () =>
      buildTraces(
        this.store
          .getTracesByRootStart(this.incidentId, {
            ...w.window,
            ...(route === undefined ? {} : { rootName: route }),
          })
          .flat(),
      ),
    );
  }
}
