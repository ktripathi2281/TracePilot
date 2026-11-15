// Incident window inference: where is the user-facing symptom, and what is a fair baseline?
//
// No ground truth and no configuration: the entry services are those that own root spans, and
// the symptom is a persistent anomaly in their error rate (preferred) or p99 latency.
//
// Step 1 needs a baseline before the incident is known. It uses robust statistics of the WHOLE
// series after warm-up, which describe normal behaviour as long as the incident covers less than
// half of the data (stated assumption). Step 2 then uses the clean pre-symptom baseline.

import type { MetricName } from '@tracepilot/schema';
import { detectAnomalies, type Anomaly, type AnomalyOptions } from './anomaly.ts';
import { findSeries, type Series, type Window } from './series.ts';

export interface WindowInferenceOptions {
  /** Telemetry range. */
  range: Window;
  entryServices: readonly string[];
  /** Ignored at the start (pools and caches warming up). Default 60 s. */
  warmupUs?: number;
  /** Gap kept between the baseline end and the symptom onset. Default 60 s. */
  guardUs?: number;
  detector?: Omit<AnomalyOptions, 'baseline' | 'scanFromUs'>;
}

export interface IncidentWindows {
  /** The symptom: the earliest-starting ongoing anomaly in an entry service. */
  symptom: {
    service: string;
    metric: string;
    onsetUs: number;
    onsetResolutionUs: number;
    status: 'ongoing' | 'recovered';
    evidenceIds: string[];
  };
  /** Pre-symptom normal behaviour. */
  baseline: Window;
  /** From the symptom onset to the end of the data. */
  incident: Window;
  /** Detector settings to reuse so later analyses see the same anomalies. */
  scanFromUs: number;
}

const SYMPTOM_METRICS: readonly MetricName[] = ['error_rate', 'latency_p99'];

export function inferIncidentWindows(
  all: readonly Series[],
  opts: WindowInferenceOptions,
): IncidentWindows | null {
  const warmup = opts.warmupUs ?? 60_000_000;
  const guard = opts.guardUs ?? 60_000_000;
  const scanFromUs = opts.range.fromUs + warmup;
  const whole: Window = { fromUs: scanFromUs, toUs: opts.range.toUs + 1 };

  let symptom: Anomaly | undefined;
  for (const metric of SYMPTOM_METRICS) {
    const found: Anomaly[] = [];
    for (const service of opts.entryServices) {
      const s = findSeries(all, service, metric);
      if (s === undefined) continue;
      const r = detectAnomalies(s, { ...opts.detector, baseline: whole, scanFromUs });
      if (Array.isArray(r)) found.push(...r.filter((a) => a.direction === 'up'));
    }
    const ongoing = found
      .filter((a) => a.status === 'ongoing')
      .sort((a, b) => a.onsetUs - b.onsetUs);
    const longest = [...found].sort((a, b) => b.samples - a.samples || a.onsetUs - b.onsetUs);
    symptom = ongoing[0] ?? longest[0];
    if (symptom !== undefined) break;
  }
  if (symptom === undefined) return null;
  const baselineEnd = Math.max(scanFromUs + 1, symptom.onsetUs - symptom.onsetResolutionUs - guard);
  return {
    symptom: {
      service: symptom.service,
      metric: symptom.metric,
      onsetUs: symptom.onsetUs,
      onsetResolutionUs: symptom.onsetResolutionUs,
      status: symptom.status,
      evidenceIds: symptom.evidenceIds,
    },
    baseline: { fromUs: scanFromUs, toUs: baselineEnd },
    incident: { fromUs: symptom.onsetUs - symptom.onsetResolutionUs, toUs: opts.range.toUs + 1 },
    scanFromUs,
  };
}
