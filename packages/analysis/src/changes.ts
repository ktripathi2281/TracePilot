// Change correlation (brief §4.7). For each change event: did anomalies in related services
// begin within a plausible lag after it? Reports correlation, never causation.
//
// Rules, applied per anomaly that begins within `maxLagUs` after the change:
// - relation: `self` (the changed service), `downstream` (something it depends on), `upstream`
//   (something that depends on it) or `unrelated`.
// - `interveningChange`: another change to a related service happened between this change and
//   the anomaly. The nearer change is the better-placed explanation.
// - `alternativeOrigin` (upstream anomalies only): an anomaly in ANOTHER dependency of the
//   anomalous service, not on the path to the changed service, began no later than this one.
//   Example: a caller slows down at the same tick as a sibling dependency; the sibling, not the
//   changed service, is the nearer explanation.
//
// Verdict per change:
//   correlated  the changed service itself shows an unexplained anomaly within the lag
//   weak        only related services show anomalies, and at least one is unexplained
//   none        no related anomaly, or every one is explained elsewhere

import type { ChangeEvent, DependencyGraph } from '@tracepilot/schema';
import type { Anomaly } from './anomaly.ts';
import { downstreamOf, upstreamOf } from './graph.ts';

export interface ChangeCorrelationOptions {
  /** Default 120 s. */
  maxLagUs?: number;
}

export type Relation = 'self' | 'downstream' | 'upstream' | 'unrelated';

export interface FollowingAnomaly {
  service: string;
  metric: string;
  direction: string;
  onsetUs: number;
  lagUs: number;
  status: 'ongoing' | 'recovered';
  relation: Relation;
  interveningChange: string | null;
  alternativeOrigin: { service: string; metric: string; onsetUs: number } | null;
  explained: boolean;
  evidenceIds: string[];
}

export interface ChangeCorrelation {
  changeId: string;
  service: string;
  ts: number;
  verdict: 'correlated' | 'weak' | 'none';
  /** Plain-language reason built from the rules above. */
  reason: string;
  following: FollowingAnomaly[];
  /** Did any related anomaly last until the end of the data? */
  sustained: boolean;
}

export function correlateChanges(
  changes: readonly ChangeEvent[],
  anomalies: readonly Anomaly[],
  graph: DependencyGraph,
  opts: ChangeCorrelationOptions = {},
): ChangeCorrelation[] {
  const maxLag = opts.maxLagUs ?? 120_000_000;
  return changes.map((change) => {
    const down = downstreamOf(graph, change.service);
    const up = upstreamOf(graph, change.service);
    const relationOf = (s: string): Relation =>
      s === change.service
        ? 'self'
        : down.has(s)
          ? 'downstream'
          : up.has(s)
            ? 'upstream'
            : 'unrelated';
    const related = (s: string): boolean => relationOf(s) !== 'unrelated';

    const following: FollowingAnomaly[] = anomalies
      .filter((a) => a.onsetUs > change.ts && a.onsetUs - change.ts <= maxLag)
      .map((a) => {
        const relation = relationOf(a.service);
        const intervening =
          changes.find(
            (c) =>
              c.id !== change.id &&
              c.ts > change.ts &&
              c.ts < a.onsetUs &&
              (c.service === a.service || related(c.service)),
          ) ?? null;
        let alternative: FollowingAnomaly['alternativeOrigin'] = null;
        if (relation === 'upstream') {
          // Dependencies of the anomalous service that are unrelated to the changed service:
          // not it, not something it depends on, not something between the two.
          const candidates = downstreamOf(graph, a.service);
          const alt = anomalies
            .filter(
              (b) =>
                candidates.has(b.service) &&
                !related(b.service) &&
                b.onsetUs <= a.onsetUs &&
                (b.endUs === null || b.endUs > a.onsetUs - a.onsetResolutionUs),
            )
            .sort((x, y) => x.onsetUs - y.onsetUs)[0];
          if (alt !== undefined)
            alternative = { service: alt.service, metric: alt.metric, onsetUs: alt.onsetUs };
        }
        return {
          service: a.service,
          metric: a.metric,
          direction: a.direction,
          onsetUs: a.onsetUs,
          lagUs: a.onsetUs - change.ts,
          status: a.status,
          relation,
          interveningChange: intervening?.id ?? null,
          alternativeOrigin: alternative,
          explained: intervening !== null || alternative !== null,
          evidenceIds: a.evidenceIds.slice(0, 2),
        };
      })
      .sort((x, y) => x.onsetUs - y.onsetUs || (x.service < y.service ? -1 : 1));

    const relatedFollowing = following.filter((f) => f.relation !== 'unrelated');
    const unexplained = relatedFollowing.filter((f) => !f.explained);
    const verdict: ChangeCorrelation['verdict'] = unexplained.some((f) => f.relation === 'self')
      ? 'correlated'
      : unexplained.length > 0
        ? 'weak'
        : 'none';
    const lagS = (us: number): string => `${(us / 1e6).toFixed(0)} s`;
    let reason: string;
    if (verdict === 'correlated') {
      const first = unexplained.find((f) => f.relation === 'self') as FollowingAnomaly;
      reason = `${change.service} itself shows ${first.metric} ${first.direction} ${lagS(first.lagUs)} after the change`;
    } else if (verdict === 'weak') {
      reason = `${change.service} itself shows no anomaly; ${String(unexplained.length)} related anomalies follow without another explanation`;
    } else if (relatedFollowing.length === 0) {
      reason = `no anomaly in ${change.service} or its dependencies/dependents within ${lagS(maxLag)}`;
    } else {
      const alts = [
        ...new Set(
          relatedFollowing.flatMap((f) =>
            f.alternativeOrigin === null ? [] : [f.alternativeOrigin.service],
          ),
        ),
      ];
      const ints = [
        ...new Set(
          relatedFollowing.flatMap((f) =>
            f.interveningChange === null ? [] : [f.interveningChange],
          ),
        ),
      ];
      reason = `${change.service} itself shows no anomaly; following anomalies are explained by ${[
        ...alts.map((s) => `an earlier-or-equal anomaly in ${s}`),
        ...ints.map((id) => `the later change ${id}`),
      ].join(' and ')}`;
    }
    return {
      changeId: change.id,
      service: change.service,
      ts: change.ts,
      verdict,
      reason,
      following,
      sustained: relatedFollowing.some((f) => f.status === 'ongoing'),
    };
  });
}
