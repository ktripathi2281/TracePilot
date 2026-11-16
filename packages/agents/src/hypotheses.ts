// Hypothesis engine (brief §6).
//
// The LLM proposes competing hypotheses. Each prediction names a FINDING of a deterministic tool
// call and the value the hypothesis expects there. This file:
// - validates a proposal: enough hypotheses, valid tool calls, required kinds covered, and
//   predictions that actually DISCRIMINATE (two hypotheses expect different values of the same
//   finding);
// - tests every prediction by running the tool and comparing: no LLM judgment involved;
// - scores hypotheses from those results alone.

import { analyzeSaturation } from '@tracepilot/analysis';
import {
  HypothesisKind,
  type FindingValue,
  type Hypothesis,
  type LedgerAuthor,
  type Prediction,
  type PredictionCheck,
} from '@tracepilot/schema';
import { z } from 'zod';
import type { Ledger } from './ledger.ts';
import type { ToolContext } from './tools/context.ts';
import { parseToolArgs, type ToolRunner } from './tools/runner.ts';
import { callKey } from './tools/types.ts';

export const PredictionProposal = z.strictObject({
  statement: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  findingKey: z.string().min(1),
  op: z.enum(['is', 'is_not']).optional(),
  expected: z.union([z.string(), z.number(), z.boolean()]),
});
export type PredictionProposal = z.infer<typeof PredictionProposal>;

export const HypothesisProposal = z.strictObject({
  kind: HypothesisKind,
  title: z.string().min(1),
  statement: z.string().min(1),
  predictions: z.array(PredictionProposal).min(2).max(6),
});
export type HypothesisProposal = z.infer<typeof HypothesisProposal>;

export const ProposeHypothesesInput = z.strictObject({
  hypotheses: z.array(HypothesisProposal).min(3).max(5),
});
export type ProposeHypothesesInput = z.infer<typeof ProposeHypothesesInput>;

/** Finding values that mean "the tool could not decide": a prediction on them is inconclusive. */
const UNDECIDED: readonly FindingValue[] = [
  'inconclusive',
  'insufficient-data',
  'unknown-capacity',
  null,
];

const normalize = (v: string | number | boolean): string | number | boolean =>
  v === 'true' ? true : v === 'false' ? false : v;

function toCheck(p: PredictionProposal, args: Record<string, unknown>): PredictionCheck {
  return {
    tool: p.tool,
    args,
    findingKey: p.findingKey,
    op: p.op ?? 'is',
    expected: normalize(p.expected),
  };
}

const findingId = (c: PredictionCheck): string => `${callKey(c.tool, c.args)}#${c.findingKey}`;

/** Two checks on the same finding that cannot both be satisfied. */
function conflicts(a: PredictionCheck, b: PredictionCheck): boolean {
  if (findingId(a) !== findingId(b)) return false;
  if (a.op === 'is' && b.op === 'is') return a.expected !== b.expected;
  if (a.op === 'is' && b.op === 'is_not') return a.expected === b.expected;
  if (a.op === 'is_not' && b.op === 'is') return a.expected === b.expected;
  return false;
}

export interface CoverageRule {
  /** Kinds every proposal must include. */
  kinds: HypothesisKind[];
  /** Why, in words the model can act on. */
  because: string;
}

/**
 * Coverage rules: explanations that standard practice says must be considered, given what the
 * telemetry shows. Deterministic and independent of any scenario.
 *
 * Rule: a saturated CONNECTION POOL has three classic competing explanations, and telling them
 * apart is the whole diagnosis: the pool is too small for real demand (connections busy
 * executing), connections are held idle while their holders wait for more (hold-and-wait), or
 * the database is slow so every connection is kept longer.
 */
export function coverageRules(ctx: ToolContext): CoverageRule[] {
  const rules: CoverageRule[] = [];
  const pools = analyzeSaturation(ctx.metrics, ctx.spans, {
    baseline: ctx.windows.baseline,
    window: ctx.windows.incident,
  }).filter((r) => r.kind === 'connection-pool' && r.status === 'saturated');
  if (pools.length > 0) {
    rules.push({
      kinds: ['pool_capacity', 'hold_and_wait', 'db_slow'],
      because: `${pools.map((p) => p.resource).join(', ')} is saturated in the incident window (see get_saturation). A saturated connection pool must be explained three competing ways: pool_capacity (too small for real demand: connections busy executing), hold_and_wait (connections held idle while holders wait for more), db_slow (queries execute slower)`,
    });
  }
  return rules;
}

/**
 * Defining predictions. A hypothesis of one of these kinds must stake itself on the finding that
 * defines the kind. Without this a label could be attached to predictions that mean something
 * else (a "pool too small" hypothesis tested as hold-and-wait would come out supported), and the
 * kind the engine copies into the root cause would mean nothing.
 */
interface Signature {
  tool: string;
  key: RegExp;
  expected: boolean;
  describe: string;
}
const SIGNATURES: Partial<Record<HypothesisKind, Signature>> = {
  hold_and_wait: {
    tool: 'analyze_hold_and_wait',
    key: /^hold_and_wait\.[^.]+\.(detected|idle_held|nested_wait)$/,
    expected: true,
    describe:
      'analyze_hold_and_wait finding hold_and_wait.<window>.detected (or idle_held, nested_wait) is true',
  },
  pool_capacity: {
    tool: 'analyze_hold_and_wait',
    key: /^hold_and_wait\.[^.]+\.(detected|idle_held)$/,
    expected: false,
    describe:
      'analyze_hold_and_wait finding hold_and_wait.<window>.idle_held is false (in-use connections are busy with database work, not held idle)',
  },
  resource_limit: {
    tool: 'get_pod_events',
    key: /^pods\.[^.]+\.[^.]+\.(oom_killed|disrupted)$/,
    expected: true,
    describe:
      'get_pod_events finding pods.<service>.<window>.oom_killed (or disrupted) is true (a pod was killed or taken out of service)',
  },
  db_slow: {
    tool: 'compare_windows',
    key: /^db_exec\.[^.]+\.flat$/,
    expected: false,
    describe:
      'compare_windows {"subject":"db_queries"} finding db_exec.<window>.flat is false (query execution got slower)',
  },
};

const satisfies = (c: PredictionCheck, sig: Signature): boolean =>
  c.tool === sig.tool &&
  sig.key.test(c.findingKey) &&
  (c.op === 'is' ? c.expected === sig.expected : c.expected === !sig.expected);

export interface ProposalCheck {
  problems: string[];
  /** Non-blocking remarks carried into the investigation record. */
  warnings: string[];
  /** Proposals with tool arguments parsed and normalized; valid only when problems is empty. */
  checks: PredictionCheck[][];
}

export function validateProposal(
  input: ProposeHypothesesInput,
  rules: readonly CoverageRule[],
): ProposalCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const checks: PredictionCheck[][] = input.hypotheses.map((h, i) =>
    h.predictions.map((p, j) => {
      const parsed = parseToolArgs(p.tool, p.args);
      if ('error' in parsed) {
        problems.push(`hypotheses[${String(i)}].predictions[${String(j)}]: ${parsed.error}`);
        return toCheck(p, p.args);
      }
      return toCheck(p, parsed.args);
    }),
  );
  const kinds = input.hypotheses.map((h) => h.kind);
  for (const rule of rules) {
    const missing = rule.kinds.filter((k) => !kinds.includes(k));
    if (missing.length > 0)
      problems.push(`missing required hypothesis kind(s) ${missing.join(', ')}: ${rule.because}`);
  }
  input.hypotheses.forEach((h, i) => {
    const sig = SIGNATURES[h.kind];
    if (sig !== undefined && !(checks[i] ?? []).some((c) => satisfies(c, sig)))
      problems.push(
        `"${h.title}" is of kind ${h.kind} and must include the prediction that defines that kind: ${sig.describe}`,
      );
  });
  const discriminated = (i: number, j: number): boolean =>
    (checks[i] ?? []).some((a) => (checks[j] ?? []).some((b) => conflicts(a, b)));
  const required = new Set(rules.flatMap((r) => r.kinds));
  for (let i = 0; i < input.hypotheses.length; i++) {
    const hi = input.hypotheses[i] as HypothesisProposal;
    let any = false;
    for (let j = 0; j < input.hypotheses.length; j++) {
      if (i === j) continue;
      const hj = input.hypotheses[j] as HypothesisProposal;
      const ok = discriminated(i, j);
      any ||= ok;
      if (!ok && i < j) {
        const msg = `"${hi.title}" and "${hj.title}" are not discriminated: give both a prediction on the SAME finding (same tool, args and findingKey) with different expected values`;
        // Required kinds must be told apart from each other; other pairs only get a warning.
        if (required.has(hi.kind) && required.has(hj.kind)) problems.push(msg);
        else warnings.push(msg);
      }
    }
    if (!any)
      problems.push(`"${hi.title}" shares no discriminating prediction with any other hypothesis`);
  }
  return { problems: [...new Set(problems)], warnings, checks };
}

export class HypothesisBoard {
  readonly hypotheses: Hypothesis[] = [];
  private hSeq = 0;
  private pSeq = 0;

  /** Adds proposed hypotheses and tests every prediction by running its tool. */
  addAndTest(
    proposals: readonly HypothesisProposal[],
    checks: readonly PredictionCheck[][],
    author: LedgerAuthor,
    runner: ToolRunner,
    ledger: Ledger,
  ): Hypothesis[] {
    const added: Hypothesis[] = [];
    proposals.forEach((proposal, i) => {
      const id = `hy_${(++this.hSeq).toString(36)}`;
      const entry = ledger.addHypothesis(author, proposal.statement, id);
      const predictions = proposal.predictions.map((p, j): Prediction => {
        const check = (checks[i] ?? [])[j] as PredictionCheck;
        return this.test(`pr_${(++this.pSeq).toString(36)}`, p.statement, check, author, runner);
      });
      const h: Hypothesis = {
        id,
        kind: proposal.kind,
        proposedBy: author,
        title: proposal.title,
        statement: proposal.statement,
        predictions,
        status: statusOf(predictions),
        ledgerEntryId: entry.id,
      };
      this.hypotheses.push(h);
      added.push(h);
    });
    return added;
  }

  private test(
    id: string,
    statement: string,
    check: PredictionCheck,
    author: LedgerAuthor,
    runner: ToolRunner,
  ): Prediction {
    const base = { id, statement, check };
    const run = runner.run(author, check.tool, check.args);
    if (!run.ok) {
      return {
        ...base,
        result: 'inconclusive',
        observed: null,
        note: `tool error: ${run.error}`,
        evidenceIds: [],
        ledgerEntryIds: [],
      };
    }
    const fact = run.facts.find((f) => f.findingKey === check.findingKey);
    if (fact === undefined) {
      const known = run.facts.map((f) => f.findingKey);
      return {
        ...base,
        result: 'inconclusive',
        observed: null,
        note: `the tool produced no finding "${check.findingKey}". Findings it produced: ${known.slice(0, 12).join(', ') || 'none'}`,
        evidenceIds: [],
        ledgerEntryIds: [],
      };
    }
    const cited = { evidenceIds: fact.evidenceIds, ledgerEntryIds: [fact.id] };
    if (UNDECIDED.includes(fact.value)) {
      return {
        ...base,
        result: 'inconclusive',
        observed: fact.value,
        note: `the finding is undecided (${String(fact.value)})`,
        ...cited,
      };
    }
    const equal = fact.value === check.expected;
    const supported = check.op === 'is' ? equal : !equal;
    return {
      ...base,
      result: supported ? 'supported' : 'contradicted',
      observed: fact.value,
      note: `expected ${check.op === 'is' ? '' : 'not '}${JSON.stringify(check.expected)}, observed ${JSON.stringify(fact.value)}`,
      ...cited,
    };
  }

  get(id: string): Hypothesis | undefined {
    return this.hypotheses.find((h) => h.id === id);
  }

  /**
   * The hypothesis the evidence favours: among those not rejected, the most supported
   * predictions, then the fewest inconclusive, then proposal order. Null if all are rejected.
   */
  leading(): Hypothesis | null {
    const count = (h: Hypothesis, r: Prediction['result']): number =>
      h.predictions.filter((p) => p.result === r).length;
    const alive = this.hypotheses.filter((h) => h.status !== 'rejected');
    const rank = (h: Hypothesis): number => (h.status === 'supported' ? 1 : 0);
    return (
      [...alive].sort(
        (a, b) =>
          rank(b) - rank(a) ||
          count(b, 'supported') - count(a, 'supported') ||
          count(a, 'inconclusive') - count(b, 'inconclusive') ||
          this.hypotheses.indexOf(a) - this.hypotheses.indexOf(b),
      )[0] ?? null
    );
  }
}

/**
 * Status from prediction results alone:
 *   rejected      any prediction contradicted (a discriminating prediction failed)
 *   supported     none contradicted, at least one supported, and no more inconclusive than supported
 *   inconclusive  otherwise
 */
export function statusOf(predictions: readonly Prediction[]): Hypothesis['status'] {
  const n = (r: Prediction['result']): number => predictions.filter((p) => p.result === r).length;
  if (n('contradicted') > 0) return 'rejected';
  if (n('supported') > 0 && n('inconclusive') <= n('supported')) return 'supported';
  return 'inconclusive';
}

/** Compact rendering of test results for the LLM. */
export function renderBoard(hypotheses: readonly Hypothesis[]): object[] {
  return hypotheses.map((h) => ({
    id: h.id,
    kind: h.kind,
    title: h.title,
    status: h.status,
    predictions: h.predictions.map((p) => ({
      statement: p.statement,
      result: p.result,
      note: p.note,
      fact: p.ledgerEntryIds[0] ?? null,
    })),
  }));
}

/** Parses the tool arguments of one proposal's predictions (used for a skeptic's new hypothesis). */
export function resolveChecks(h: HypothesisProposal): {
  checks: PredictionCheck[];
  problems: string[];
} {
  const problems: string[] = [];
  const checks = h.predictions.map((p, j) => {
    const parsed = parseToolArgs(p.tool, p.args);
    if ('error' in parsed) {
      problems.push(`predictions[${String(j)}]: ${parsed.error}`);
      return toCheck(p, p.args);
    }
    return toCheck(p, parsed.args);
  });
  return { checks, problems };
}
