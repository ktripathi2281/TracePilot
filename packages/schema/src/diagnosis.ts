import { z } from 'zod';
import { HypothesisId, LedgerEntryId, RecommendationId, ServiceName } from './ids.ts';
import { Patch } from './patch.ts';

// Final diagnosis (brief §6). Every claim points at ledger entries; the ledger points at evidence.

const Cited = {
  statement: z.string().min(1),
  ledgerEntryIds: z.array(LedgerEntryId).min(1),
};

export const RootCause = z.strictObject({ ...Cited });
export type RootCause = z.infer<typeof RootCause>;

export const CausalStep = z.strictObject({
  ...Cited,
  service: ServiceName.optional(),
});
export type CausalStep = z.infer<typeof CausalStep>;

export const RejectedHypothesis = z.strictObject({
  hypothesisId: HypothesisId,
  title: z.string().min(1),
  /** Why it was rejected; cites the ledger entries holding the contradicting evidence. */
  reason: z.string().min(1),
  ledgerEntryIds: z.array(LedgerEntryId).min(1),
});
export type RejectedHypothesis = z.infer<typeof RejectedHypothesis>;

export const ConfidenceLevel = z.enum(['low', 'medium', 'high']);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

/** Computed by a deterministic rubric from prediction results; never LLM-stated. */
export const Confidence = z.strictObject({
  score: z.number().min(0).max(1),
  level: ConfidenceLevel,
  basis: z.strictObject({
    supportedPredictions: z.number().int().nonnegative(),
    contradictedPredictions: z.number().int().nonnegative(),
    inconclusivePredictions: z.number().int().nonnegative(),
    unresolvedContradictions: z.number().int().nonnegative(),
  }),
});
export type Confidence = z.infer<typeof Confidence>;

export const Recommendation = z.strictObject({
  id: RecommendationId,
  title: z.string().min(1),
  rationale: z.string().min(1),
  /** Feeds straight into the replay engine. */
  patch: Patch,
  ledgerEntryIds: z.array(LedgerEntryId).min(1),
});
export type Recommendation = z.infer<typeof Recommendation>;

export const VerifierIssueCode = z.enum([
  'missing_evidence',
  'value_mismatch',
  'hypothesis_as_premise',
  'temporal_precedence',
  'unsupported_logic',
]);
export type VerifierIssueCode = z.infer<typeof VerifierIssueCode>;

export const VerifierIssue = z.strictObject({
  code: VerifierIssueCode,
  message: z.string().min(1),
  ledgerEntryIds: z.array(LedgerEntryId),
});
export type VerifierIssue = z.infer<typeof VerifierIssue>;

export const Diagnosis = z.strictObject({
  rootCause: RootCause,
  /** Ordered from root cause to user-facing symptom. */
  causalChain: z.array(CausalStep).min(1),
  affectedServices: z.array(ServiceName).min(1),
  rejectedHypotheses: z.array(RejectedHypothesis),
  confidence: Confidence,
  unknowns: z.array(z.string().min(1)),
  recommendations: z.array(Recommendation),
  /** Issues still open after the max revision rounds. Must be shown, never hidden. */
  unresolvedIssues: z.array(VerifierIssue),
});
export type Diagnosis = z.infer<typeof Diagnosis>;
