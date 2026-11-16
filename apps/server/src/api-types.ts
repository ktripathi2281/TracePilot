// Types of the API's JSON responses, for the web UI. Type-only: the UI imports nothing at runtime
// from the server or the packages behind it (lint enforces it); it talks to the server over HTTP.

import type { InvestigationSource, knobCatalog } from './app.ts';
import type { overview, serviceDetail, timeline } from './views.ts';

export type Overview = ReturnType<typeof overview>;
export type Timeline = ReturnType<typeof timeline>;
export type ServiceDetail = ReturnType<typeof serviceDetail>;
export type KnobCatalog = ReturnType<typeof knobCatalog>;
export type { Health, Headline, ServiceHealth, TraceSummary } from './views.ts';
export type { InvestigationSource } from './app.ts';

import type { Investigation } from '@tracepilot/agents';
import type { IncidentWindows } from '@tracepilot/analysis';
import type { Incident } from '@tracepilot/store';
import type { Headline } from './views.ts';
export type { Investigation, InvestigationEvent } from '@tracepilot/agents';
export type { RecommendationComparison, ReplayRun, Sweep } from '@tracepilot/replay';
export type { Evidence, Incident } from '@tracepilot/store';
export type {
  ChangeEvent,
  Hypothesis,
  LedgerEntry,
  Patch,
  Span,
  VerifierIssue,
} from '@tracepilot/schema';

/** An incident with its symptom and incident window, inferred from its telemetry. */
export type IncidentSummary = Incident & {
  symptom: IncidentWindows['symptom'] | null;
  window: { fromUs: number; toUs: number };
  /** p99, failed requests and ok throughput of the entry services in the incident window. */
  headline: Headline;
};

export interface InvestigationResponse {
  source: InvestigationSource;
  investigation: Investigation;
}
