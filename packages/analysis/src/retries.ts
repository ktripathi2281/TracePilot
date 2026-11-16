// Retry statistics per called service, from sampled server spans: how many of the requests a
// service received were retries (`retry.attempt` > 1). A high share means callers are multiplying
// the load on a service that is already failing. Pure; reads only the spans passed in.

import { SPAN_ATTRS, spanEvidenceId, type Span } from '@tracepilot/schema';
import { inWindow, type Window } from './series.ts';

export interface RetryStats {
  service: string;
  /** Server spans (requests received) starting in the window. */
  requests: number;
  /** Of those, retries (attempt 2 or later). */
  retries: number;
  share: number;
  /** requests / first attempts: how much retries multiplied the work. */
  amplification: number;
  /** Up to 6 retried spans, for citation; the first request received when there was no retry. */
  evidenceIds: string[];
}

export function analyzeRetries(spans: readonly Span[], window: Window): RetryStats[] {
  const by = new Map<
    string,
    { requests: number; retries: number; evidence: string[]; first: string }
  >();
  for (const s of spans) {
    // Server spans carry the request type; client-side and internal spans do not.
    if (!(SPAN_ATTRS.requestType in s.attributes) || !inWindow(s.startUs, window)) continue;
    let e = by.get(s.service);
    if (e === undefined)
      by.set(
        s.service,
        (e = { requests: 0, retries: 0, evidence: [], first: spanEvidenceId(s.spanId) }),
      );
    e.requests++;
    const attempt = s.attributes[SPAN_ATTRS.attempt];
    if (typeof attempt === 'number' && attempt > 1) {
      e.retries++;
      if (e.evidence.length < 6) e.evidence.push(spanEvidenceId(s.spanId));
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([service, e]) => ({
      service,
      requests: e.requests,
      retries: e.retries,
      share: e.requests === 0 ? 0 : e.retries / e.requests,
      amplification: e.requests - e.retries === 0 ? 1 : e.requests / (e.requests - e.retries),
      evidenceIds: e.evidence.length > 0 ? e.evidence : [e.first],
    }));
}
