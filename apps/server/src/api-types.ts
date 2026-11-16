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

export interface InvestigationResponse {
  source: InvestigationSource;
  investigation: Investigation;
}
