// Pod lifecycle summary (Kubernetes-style pod events): per service, what happened to its pods in a
// window. Pure; reads only the events passed in.

import type { PodEvent } from '@tracepilot/schema';
import { inWindow, type Window } from './series.ts';

export interface PodSummary {
  service: string;
  /** Pods with at least one event in the window, sorted. */
  pods: string[];
  oomKilled: number;
  crashLoopBackOff: number;
  restarted: number;
  evicted: number;
  readinessFailed: number;
  /** First OOMKilled event in the window, or null. */
  firstOomKilled: { ts: number; evidenceId: string } | null;
  /** First event of any kind that took a pod out of service (OOMKilled, Evicted, ReadinessFailed). */
  firstDisruption: { ts: number; evidenceId: string; reason: PodEvent['reason'] } | null;
  /** Up to 8 events, disruptions first, for citation. */
  evidenceIds: string[];
}

const DISRUPTIONS: readonly PodEvent['reason'][] = ['OOMKilled', 'Evicted', 'ReadinessFailed'];

export function summarizePods(events: readonly PodEvent[], window: Window): PodSummary[] {
  const byService = new Map<string, PodEvent[]>();
  for (const e of events) {
    if (!inWindow(e.ts, window)) continue;
    const list = byService.get(e.service);
    if (list === undefined) byService.set(e.service, [e]);
    else list.push(e);
  }
  return [...byService.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([service, list]) => {
      const sorted = [...list].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
      const count = (r: PodEvent['reason']): number => sorted.filter((e) => e.reason === r).length;
      const oom = sorted.find((e) => e.reason === 'OOMKilled');
      const disruption = sorted.find((e) => DISRUPTIONS.includes(e.reason));
      const evidence = [
        ...sorted.filter((e) => DISRUPTIONS.includes(e.reason)),
        ...sorted.filter((e) => !DISRUPTIONS.includes(e.reason)),
      ]
        .slice(0, 8)
        .map((e) => e.id);
      return {
        service,
        pods: [...new Set(sorted.map((e) => e.pod))].sort(),
        oomKilled: count('OOMKilled'),
        crashLoopBackOff: count('CrashLoopBackOff'),
        restarted: count('Restarted'),
        evicted: count('Evicted'),
        readinessFailed: count('ReadinessFailed'),
        firstOomKilled: oom === undefined ? null : { ts: oom.ts, evidenceId: oom.id },
        firstDisruption:
          disruption === undefined
            ? null
            : { ts: disruption.ts, evidenceId: disruption.id, reason: disruption.reason },
        evidenceIds: evidence,
      };
    });
}
