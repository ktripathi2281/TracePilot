import { z } from 'zod';
import { EvidenceId, HypothesisId, LedgerEntryId } from './ids.ts';

// Evidence ledger (brief §6). Every statement in a diagnosis is one of FACT / INFERENCE /
// HYPOTHESIS. The schema enforces SHAPE; the deterministic verifier (Phase 3) enforces that
// cited IDs exist, quoted numbers match the store, no HYPOTHESIS is used as a premise, and
// temporal precedence holds.

export const LedgerAuthor = z.enum(['investigator', 'skeptic', 'verifier']);
export type LedgerAuthor = z.infer<typeof LedgerAuthor>;

/**
 * A number quoted in a FACT, tied to the evidence item it was read from. The verifier re-reads
 * `field` from `evidenceId` in the store and compares within tolerance.
 */
export const QuotedQuantity = z.strictObject({
  evidenceId: EvidenceId,
  /** Field on the evidence item, e.g. `value`, `durationUs`, `attributes.db.pool.in_use`, `ts`. */
  field: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
});
export type QuotedQuantity = z.infer<typeof QuotedQuantity>;

const base = {
  id: LedgerEntryId,
  author: LedgerAuthor,
  statement: z.string().min(1),
};

export const FactEntry = z
  .strictObject({
    ...base,
    type: z.literal('FACT'),
    /** Name of the deterministic tool whose result this fact was read from. */
    tool: z.string().min(1),
    evidenceIds: z.array(EvidenceId).min(1),
    quantities: z.array(QuotedQuantity),
  })
  .refine((f) => f.quantities.every((q) => f.evidenceIds.includes(q.evidenceId)), {
    message: 'every quoted quantity must cite one of the entry evidenceIds',
    path: ['quantities'],
  });
export type FactEntry = z.infer<typeof FactEntry>;

export const InferenceEntry = z
  .strictObject({
    ...base,
    type: z.literal('INFERENCE'),
    /** Named derivation rule, e.g. `onset-order-along-dependency-edge`. */
    rule: z.string().min(1),
    premises: z.array(LedgerEntryId).min(1),
  })
  .refine((e) => !e.premises.includes(e.id), {
    message: 'an entry cannot be its own premise',
    path: ['premises'],
  });
export type InferenceEntry = z.infer<typeof InferenceEntry>;

export const HypothesisEntry = z.strictObject({
  ...base,
  type: z.literal('HYPOTHESIS'),
  hypothesisId: HypothesisId.optional(),
});
export type HypothesisEntry = z.infer<typeof HypothesisEntry>;

export const LedgerEntry = z.discriminatedUnion('type', [
  FactEntry,
  InferenceEntry,
  HypothesisEntry,
]);
export type LedgerEntry = z.infer<typeof LedgerEntry>;
export type LedgerEntryType = LedgerEntry['type'];
