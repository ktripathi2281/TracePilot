import { z } from 'zod';
import { EvidenceId, HypothesisId, LedgerEntryId } from './ids.ts';
import { DurationUs, VirtualTimeUs } from './time.ts';

// Evidence ledger (brief §6). Every statement in a diagnosis is one of FACT / INFERENCE /
// HYPOTHESIS. The schema enforces SHAPE; the deterministic verifier (packages/agents) enforces
// that cited IDs exist, numbers match the store, no HYPOTHESIS is used as a premise, and temporal
// precedence holds.
//
// FACTs are never written by the LLM. A FACT is one FINDING of a deterministic tool call: the
// tool layer creates the entry, with a templated statement and the numbers it computed. The LLM
// can only cite facts by ID. The verifier can therefore check a FACT two ways: read the directly
// quoted fields back from the store, and re-run the tool call and compare the finding.

export const LedgerAuthor = z.enum(['investigator', 'skeptic', 'verifier']);
export type LedgerAuthor = z.infer<typeof LedgerAuthor>;

/**
 * A number read directly from one stored evidence item. The verifier re-reads `field` from
 * `evidenceId` and compares.
 */
export const QuotedQuantity = z.strictObject({
  evidenceId: EvidenceId,
  /** Field on the evidence item: `value`, `ts`, `startUs`, `endUs`, `durationUs`, `attributes.<key>`, `diff.<key>.from|to`. */
  field: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
});
export type QuotedQuantity = z.infer<typeof QuotedQuantity>;

/** A number computed over many evidence items (a median, a share, a ratio). Verified by recomputation. */
export const DerivedQuantity = z.strictObject({
  name: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
});
export type DerivedQuantity = z.infer<typeof DerivedQuantity>;

/** When the fact began to hold: somewhere in (tsUs − resolutionUs, tsUs]. */
export const OccurredAt = z.strictObject({ tsUs: VirtualTimeUs, resolutionUs: DurationUs });
export type OccurredAt = z.infer<typeof OccurredAt>;

/** Categorical outcome of a finding (what predictions are tested against). */
export const FindingValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FindingValue = z.infer<typeof FindingValue>;

const base = {
  id: LedgerEntryId,
  author: LedgerAuthor,
  statement: z.string().min(1),
};

export const FactEntry = z
  .strictObject({
    ...base,
    type: z.literal('FACT'),
    /** The deterministic tool call this fact is a finding of. Re-running it must reproduce the fact. */
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    /** Stable key of the finding within that tool call's output. */
    findingKey: z.string().min(1),
    value: FindingValue,
    evidenceIds: z.array(EvidenceId).min(1),
    quantities: z.array(QuotedQuantity),
    derived: z.array(DerivedQuantity),
    occurredAt: OccurredAt.optional(),
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
