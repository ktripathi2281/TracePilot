// Confidence rubric (brief §6): computed from test results and open problems, never stated by
// the LLM.
//
//   base      = supported predictions / all predictions of the root-cause hypothesis
//   − 0.25    per skeptic challenge that REFUTED the leading hypothesis
//   − 0.10    if any skeptic challenge WEAKENED it
//   − 0.10    if the skeptic found temporal precedence violated
//   − 0.10    if no alternative hypothesis was rejected (nothing was actually discriminated)
//   − 0.10    if there is no valid skeptic challenge (the leading hypothesis went unchallenged)
//   − 0.15    per verifier issue still unresolved at publication (at most 3 counted)
// clamped to [0, 1]; high ≥ 0.75, medium ≥ 0.5, else low.

import type { Confidence, Hypothesis, VerifierIssue } from '@tracepilot/schema';
import type { SkepticReport } from './investigation.ts';

export function computeConfidence(
  root: Hypothesis,
  hypotheses: readonly Hypothesis[],
  skeptic: SkepticReport | null,
  unresolved: readonly VerifierIssue[],
): Confidence {
  const count = (r: string): number => root.predictions.filter((p) => p.result === r).length;
  const supported = count('supported');
  const contradicted = count('contradicted');
  const inconclusive = count('inconclusive') + count('pending');
  const refuted = skeptic?.againstLeading.filter((c) => c.verdict === 'refuted').length ?? 0;
  const weakened = skeptic?.againstLeading.some((c) => c.verdict === 'weakened') ?? false;
  const precedenceViolated = skeptic?.temporalPrecedence.verdict === 'violated';
  const rejectedAlternatives = hypotheses.filter(
    (h) => h.id !== root.id && h.status === 'rejected',
  ).length;

  let score = root.predictions.length === 0 ? 0 : supported / root.predictions.length;
  score -= 0.25 * refuted;
  if (weakened) score -= 0.1;
  if (precedenceViolated) score -= 0.1;
  if (rejectedAlternatives === 0) score -= 0.1;
  if (skeptic === null) score -= 0.1;
  score -= 0.15 * Math.min(3, unresolved.length);
  score = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;

  return {
    score,
    level: score >= 0.75 ? 'high' : score >= 0.5 ? 'medium' : 'low',
    basis: {
      supportedPredictions: supported,
      contradictedPredictions: contradicted,
      inconclusivePredictions: inconclusive,
      unresolvedContradictions: contradicted + refuted + (precedenceViolated ? 1 : 0),
    },
  };
}
