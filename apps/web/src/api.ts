// HTTP client for the TracePilot server. Every number the UI shows comes from these responses:
// telemetry analyses, saved records and simulator output. The UI computes none.

import type {
  Evidence,
  IncidentSummary,
  InvestigationEvent,
  InvestigationResponse,
  KnobCatalog,
  Overview,
  Patch,
  RecommendationComparison,
  ReplayRun,
  ServiceDetail,
  Span,
  Sweep,
  Timeline,
} from '@tracepilot/server/api-types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  const data: unknown = text === '' ? null : JSON.parse(text);
  if (!res.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `HTTP ${String(res.status)}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const inc = (id: string): string => `/api/incidents/${encodeURIComponent(id)}`;

export const api = {
  incidents: () => call<IncidentSummary[]>('/api/incidents'),
  overview: (id: string) => call<Overview>(`${inc(id)}/overview`),
  timeline: (id: string) => call<Timeline>(`${inc(id)}/timeline`),
  service: (id: string, service: string) =>
    call<ServiceDetail>(`${inc(id)}/services/${encodeURIComponent(service)}`),
  trace: (id: string, traceId: string) => call<Span[]>(`${inc(id)}/traces/${traceId}`),
  evidence: (id: string, evidenceId: string) =>
    call<Evidence>(`${inc(id)}/evidence/${encodeURIComponent(evidenceId)}`),
  investigation: (id: string) => call<InvestigationResponse>(`${inc(id)}/investigation`),
  knobs: (id: string) => call<KnobCatalog>(`${inc(id)}/replay/knobs`),
  replay: (id: string, patches: Patch[]) => post<ReplayRun>(`${inc(id)}/replay`, { patches }),
  replayDiagnosis: (id: string) =>
    post<RecommendationComparison>(`${inc(id)}/replay/diagnosis`, {}),
  sweep: (id: string, param: string, values: number[], patches: Patch[] = []) =>
    post<Sweep>(`${inc(id)}/sweep`, { param, values, patches }),
};

/** Runs an investigation on the server and reports its events as they stream in (SSE over POST). */
export async function runInvestigation(
  id: string,
  mode: 'fixture' | 'env',
  onEvent: (e: InvestigationEvent) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${inc(id)}/investigation/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok || res.body === null) {
    const text = await res.text();
    return { ok: false, error: text === '' ? `HTTP ${String(res.status)}` : text };
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let result: { ok: true } | { ok: false; error: string } = {
    ok: false,
    error: 'stream ended early',
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (event === 'progress') onEvent(JSON.parse(data) as InvestigationEvent);
      else if (event === 'done') result = { ok: true };
      else if (event === 'error')
        result = { ok: false, error: (JSON.parse(data) as { error: string }).error };
    }
  }
  return result;
}
