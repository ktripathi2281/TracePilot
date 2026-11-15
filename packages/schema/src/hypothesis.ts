import { z } from 'zod';
import { EvidenceId, HypothesisId, LedgerEntryId, PredictionId } from './ids.ts';

// Hypotheses with discriminating, testable predictions (brief §6). Scores come from prediction
// RESULTS checked by tools, never from LLM self-reported confidence, so there is no confidence
// field here on purpose.

export const PredictionResult = z.enum(['pending', 'supported', 'contradicted', 'inconclusive']);
export type PredictionResult = z.infer<typeof PredictionResult>;

export const Prediction = z
  .strictObject({
    id: PredictionId,
    statement: z.string().min(1),
    /** How it is checked, e.g. `attribute_latency: pool-acquire share > 50% of checkout p99`. */
    check: z.string().min(1),
    result: PredictionResult,
    evidenceIds: z.array(EvidenceId),
    ledgerEntryIds: z.array(LedgerEntryId),
  })
  .refine(
    (p) => (p.result !== 'supported' && p.result !== 'contradicted') || p.evidenceIds.length > 0,
    { message: 'a supported/contradicted prediction must cite evidence', path: ['evidenceIds'] },
  );
export type Prediction = z.infer<typeof Prediction>;

export const HypothesisStatus = z.enum(['proposed', 'supported', 'rejected', 'inconclusive']);
export type HypothesisStatus = z.infer<typeof HypothesisStatus>;

export const Hypothesis = z.strictObject({
  id: HypothesisId,
  title: z.string().min(1),
  statement: z.string().min(1),
  predictions: z.array(Prediction).min(1),
  status: HypothesisStatus,
});
export type Hypothesis = z.infer<typeof Hypothesis>;
