import { z } from 'zod';
import { HypothesisId, LedgerEntryId, RecommendationId, ServiceName } from './ids.ts';
import { HypothesisKind } from './hypothesis.ts';
import { Patch } from './patch.ts';

// Final diagnosis (brief §6). Every claim points at ledger entries; the ledger points at evidence.

const Cited = {
  statement: z.string().min(1),
  ledgerEntryIds: z.array(LedgerEntryId).min(1),
};

export const RootCause = z.strictObject({
  ...Cited,
  /** The hypothesis this root cause is: must be one the engine did not reject. */
  hypothesisId: HypothesisId,
  /** Its kind, copied by the engine from that hypothesis: the STRUCTURAL class of the cause. */
  kind: HypothesisKind,
});
export type RootCause = z.infer<typeof RootCause>;

export const CausalStep = z
  .strictObject({
    ...Cited,
    service: ServiceName.optional(),
    /**
     * The cited FACT that dates when this step began (it must carry `occurredAt`). The verifier
     * checks that no step certainly begins before the step that precedes it in the chain.
     */
    onsetEntryId: LedgerEntryId,
  })
  .refine((s) => s.ledgerEntryIds.includes(s.onsetEntryId), {
    message: 'onsetEntryId must be one of the step ledgerEntryIds',
    path: ['onsetEntryId'],
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
  /** Does this remove the cause, or only its effect? */
  addresses: z.enum(['cause', 'symptom']),
  ledgerEntryIds: z.array(LedgerEntryId).min(1),
});
export type Recommendation = z.infer<typeof Recommendation>;

/** A fix that needs a human (e.g. a code change) and cannot be expressed as a replay patch. */
export const FollowUp = z.strictObject({
  title: z.string().min(1),
  rationale: z.string().min(1),
  ledgerEntryIds: z.array(LedgerEntryId).min(1),
});
export type FollowUp = z.infer<typeof FollowUp>;

export const VerifierIssueCode = z.enum([
  /** A cited evidence ID or ledger entry does not exist. */
  'missing_evidence',
  /** A quoted or recomputed number does not match the store. */
  'value_mismatch',
  /** A number in LLM-written text does not appear in the facts it cites. */
  'ungrounded_number',
  /** A HYPOTHESIS entry is used as a premise or cited as support for a claim. */
  'hypothesis_as_premise',
  /** A causal step certainly begins before the step preceding it. */
  'temporal_precedence',
  /** A claim does not follow from what it cites (rule-based or LLM verifier pass). */
  'unsupported_logic',
]);
export type VerifierIssueCode = z.infer<typeof VerifierIssueCode>;

export const VerifierIssue = z.strictObject({
  code: VerifierIssueCode,
  /** Where in the diagnosis: `rootCause`, `causalChain[2]`, `ledger:le_7`, ... */
  location: z.string().min(1),
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
  followUps: z.array(FollowUp),
  /** Issues still open after the max revision rounds. Must be shown, never hidden. */
  unresolvedIssues: z.array(VerifierIssue),
});
export type Diagnosis = z.infer<typeof Diagnosis>;
