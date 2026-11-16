// The record of one investigation, and the events it emits while running.

import {
  Confidence,
  Diagnosis,
  Hypothesis,
  IncidentId,
  LedgerEntry,
  VerifierIssue,
  type Hypothesis as HypothesisT,
} from '@tracepilot/schema';
import { z } from 'zod';
import { HypothesisProposal } from './hypotheses.ts';

const Ids = z.array(z.string().min(1)).min(1);
const Cited = { statement: z.string().min(1), ledgerEntryIds: Ids };

/** What the skeptic submits. */
export const ChallengeInput = z.strictObject({
  againstLeading: z
    .array(z.strictObject({ ...Cited, verdict: z.enum(['holds', 'weakened', 'refuted']) }))
    .min(1),
  strongestAlternative: z.strictObject({
    /** An existing hypothesis other than the leading one... */
    hypothesisId: z.string().min(1).optional(),
    /** ...or a new one, tested by the engine like any other. */
    newHypothesis: HypothesisProposal.optional(),
    argument: z.string().min(1),
    checks: z
      .array(
        z.strictObject({
          ...Cited,
          verdict: z.enum(['supports_alternative', 'contradicts_alternative', 'inconclusive']),
        }),
      )
      .min(1),
  }),
  redHerrings: z.array(
    z.strictObject({
      subject: z.string().min(1),
      verdict: z.enum(['not_causal', 'possibly_causal']),
      reason: z.string().min(1),
      ledgerEntryIds: Ids,
    }),
  ),
  temporalPrecedence: z.strictObject({
    ...Cited,
    verdict: z.enum(['consistent', 'violated', 'inconclusive']),
  }),
});
export type ChallengeInput = z.infer<typeof ChallengeInput>;

export const SkepticReport = z.strictObject({
  leadingHypothesisId: z.string(),
  alternativeHypothesisId: z.string(),
  /** Tool calls nobody had made before the skeptic made them. */
  newQueries: z.array(z.string()),
  againstLeading: ChallengeInput.shape.againstLeading,
  alternativeArgument: z.string(),
  alternativeChecks: ChallengeInput.shape.strongestAlternative.shape.checks,
  redHerrings: ChallengeInput.shape.redHerrings,
  temporalPrecedence: ChallengeInput.shape.temporalPrecedence,
});
export type SkepticReport = z.infer<typeof SkepticReport>;

export const VerificationRound = z.strictObject({
  /** 0 = first submission, 1 and 2 = revisions. */
  round: z.number().int().nonnegative(),
  deterministicIssues: z.array(VerifierIssue),
  /** Whether the LLM logic pass ran (it runs only when the deterministic pass is clean). */
  llmPass: z.enum(['ran', 'not_reached', 'no_verdict']),
  llmIssues: z.array(VerifierIssue),
});
export type VerificationRound = z.infer<typeof VerificationRound>;

export const UsageRecord = z.strictObject({
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  totalTokens: z.number(),
  budgetTokens: z.number(),
  estimatedCostUsd: z.number().nullable(),
  byRole: z.record(z.string(), z.strictObject({ calls: z.number(), totalTokens: z.number() })),
});

export const Investigation = z.strictObject({
  formatVersion: z.literal(1),
  incidentId: IncidentId,
  /** diagnosed: a diagnosis was published (possibly with unresolved issues). inconclusive: none could be. */
  outcome: z.enum(['diagnosed', 'inconclusive']),
  llm: z.strictObject({
    mode: z.enum(['live', 'record', 'replay', 'scripted']),
    /** True when every LLM response came from a cassette: the UI must show a "Recorded run" badge. */
    recorded: z.boolean(),
    model: z.string(),
    verifierModel: z.string(),
    effort: z.string(),
    /** Every model that actually answered a request, as the API reported it. */
    answeredBy: z.array(z.string()),
  }),
  usage: UsageRecord,
  hypotheses: z.array(Hypothesis),
  leadingHypothesisId: z.string().nullable(),
  skeptic: SkepticReport.nullable(),
  verification: z.array(VerificationRound),
  /** How many times the diagnosis was sent back (max 2). */
  revisionRounds: z.number().int().nonnegative(),
  ledger: z.array(LedgerEntry),
  diagnosis: Diagnosis.nullable(),
  confidence: Confidence.nullable(),
  /** Things the engine noticed that the reader should know (never hidden). */
  warnings: z.array(z.string()),
});
export type Investigation = z.infer<typeof Investigation>;

export type Role = 'investigator' | 'skeptic' | 'verifier';

/** Streamed while an investigation runs (CLI --stream now, SSE in Phase 5). */
export type InvestigationEvent =
  | {
      type: 'stage';
      stage: 'investigating' | 'testing_hypotheses' | 'skeptic' | 'verifying' | 'done';
      detail?: string;
    }
  | {
      type: 'tool';
      role: Role;
      tool: string;
      args: Record<string, unknown>;
      ok: boolean;
      summary: string;
      facts: number;
    }
  | { type: 'inference'; role: Role; id: string; statement: string }
  | { type: 'hypotheses'; hypotheses: HypothesisT[]; leadingHypothesisId: string | null }
  | { type: 'rejected_input'; role: Role; tool: string; problems: string[] }
  | { type: 'skeptic'; report: SkepticReport }
  | { type: 'verification'; round: VerificationRound; accepted: boolean }
  | { type: 'usage'; role: Role; totalTokens: number; budgetTokens: number };
