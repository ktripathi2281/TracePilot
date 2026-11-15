// The deterministic analysis pipeline over ONE incident, reading only through the store.
//
// This is what the agent tools (Phase 3) will wrap. It imports nothing from the simulator and
// takes nothing but a store and an incident ID: whatever it finds, it found in telemetry.

import {
  analyzeHoldAndWait,
  analyzePropagation,
  analyzeSaturation,
  attributeLatency,
  buildDependencyGraph,
  buildTimeline,
  buildTraces,
  correlateChanges,
  dbQueryProfile,
  detectLogBursts,
  inferIncidentWindows,
  refineOnsetsFromSpans,
  scanAnomalies,
  toSeries,
  type Window,
} from '@tracepilot/analysis';
import type { TelemetryStore } from '@tracepilot/store';

export type IncidentAnalysis = ReturnType<typeof analyzeIncident>;

export function analyzeIncident(store: TelemetryStore, incidentId: string) {
  const incident = store.getIncident(incidentId);
  const tick = incident.metricIntervalUs;
  if (tick === null) throw new Error('incident has no metrics');
  const metrics = store.getMetrics(incidentId);
  const spans = store.getSpans(incidentId);
  const series = toSeries(metrics);
  const graph = buildDependencyGraph(spans);
  const windows = inferIncidentWindows(series, {
    range: { fromUs: incident.startUs, toUs: incident.endUs },
    entryServices: graph.entryServices,
  });
  if (windows === null) throw new Error('no user-facing symptom found');
  const { baseline, incident: window } = windows;

  const anomalies = scanAnomalies(series, { baseline, scanFromUs: windows.scanFromUs });
  const refined = refineOnsetsFromSpans(spans, { baseline, fromUs: baseline.toUs, windowUs: tick });
  const propagation = analyzePropagation(graph, anomalies.anomalies, {
    incident: window,
    refinedOnsets: refined.onsets,
    refinedByOperation: refined.byOperation,
  });
  const changes = store.listChangeEvents(incidentId);
  const changeCorrelation = correlateChanges(changes, anomalies.anomalies, graph);
  const saturation = analyzeSaturation(metrics, spans, { baseline, window });
  const saturationInBaseline = analyzeSaturation(metrics, spans, { baseline, window: baseline });
  const logBursts = detectLogBursts(store.searchLogs(incidentId, { levels: ['warn', 'error'] }), {
    baseline,
    bucketUs: tick,
  });

  // Requests entering through each entry service, per window.
  const tracesIn = (w: Window) => buildTraces(store.getTracesByRootStart(incidentId, w).flat());
  // Settled part of the incident: one minute in, so requests that started before it are gone.
  const settled: Window = { fromUs: window.fromUs + 60_000_000, toUs: window.toUs };
  const baselineTraces = tracesIn(baseline);
  const incidentTraces = tracesIn(settled);
  const dbMetrics = metrics.filter((m) => m.service === 'db');

  return {
    incident,
    graph,
    windows,
    anomalies,
    refined,
    propagation,
    changeCorrelation,
    saturation,
    saturationInBaseline,
    logBursts,
    attribution: {
      baseline: attributeLatency(baselineTraces),
      incident: attributeLatency(incidentTraces),
    },
    holdAndWait: {
      baseline: analyzeHoldAndWait(dbMetrics, baselineTraces, baseline),
      incident: analyzeHoldAndWait(dbMetrics, incidentTraces, settled),
    },
    dbQueries: dbQueryProfile(spans, baseline, settled),
    timeline: buildTimeline({
      changes,
      anomalies: anomalies.anomalies,
      logBursts,
      spanOnsets: Object.values(refined.onsets),
    }),
  };
}
