// Tool contract. A data tool is a thin, deterministic wrapper over store + analysis (brief §6).
// Its output is the ONLY source of facts for the LLM roles.

import type { DerivedQuantity, FindingValue, OccurredAt, QuotedQuantity } from '@tracepilot/schema';
import type { z } from 'zod';
import type { ToolContext } from './context.ts';

/**
 * One citable result of a tool call. The tool layer turns each finding into a FACT ledger entry;
 * `key` is stable for a given (tool, args), so the verifier can re-run the call and compare, and
 * predictions can name the finding they are about.
 */
export interface Finding {
  key: string;
  /** Deterministic, templated sentence. Any number in it was computed by the tool. */
  statement: string;
  /** Categorical outcome predictions are tested against. */
  value: FindingValue;
  evidenceIds: string[];
  /** Numbers read directly from one evidence item. */
  quantities: QuotedQuantity[];
  /** Numbers computed over many items. */
  derived: DerivedQuantity[];
  occurredAt?: OccurredAt;
}

export type Row = Record<string, string | number | boolean | null>;

export interface ToolOutput {
  /** One or two sentences for the LLM. */
  summary: string;
  findings: Finding[];
  /** Compact supporting data that is not itself citable (e.g. log lines, span tree). */
  rows?: Row[];
  notes?: string[];
}

export interface ToolDef<Schema extends z.ZodType = z.ZodType> {
  name: string;
  /** Shown to the LLM. Must document the finding keys and their possible values. */
  description: string;
  input: Schema;
  run: (ctx: ToolContext, args: z.infer<Schema>) => ToolOutput;
}

/** Keys sorted recursively, so equal arguments always serialize identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** Identity of a tool call: same key ⇒ same output. */
export const callKey = (tool: string, args: unknown): string => `${tool}(${canonicalJson(args)})`;
