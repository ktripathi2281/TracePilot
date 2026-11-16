// Investigation orchestrator (brief §6): one tool-using investigator loop, a skeptic in a
// separate context, and a verifier.
//
//   investigator ── data tools ──► facts in the ledger
//        │ propose_hypotheses
//        ▼
//   engine: validate (coverage, discrimination) → run every prediction's tool → score
//        │
//        ▼
//   skeptic (own prompt, own context): ≥ N NEW queries against the leading hypothesis and the
//        │                             strongest alternative → challenge written to the ledger
//        ▼
//   investigator: submit_diagnosis
//        │
//        ▼
//   verifier: deterministic pass, then LLM logic pass. Any issue goes back to the investigator.
//             At most 2 revision rounds, then publish with the open issues listed.
//
// The LLM decides what to look at and what to claim. It never produces a number, a prediction
// result, a hypothesis status or a confidence: those come from tools and from this engine.

import {
  Diagnosis,
  type Hypothesis,
  type LedgerEntry,
  type VerifierIssue,
} from '@tracepilot/schema';
import type { TelemetryStore } from '@tracepilot/store';
import { z } from 'zod';
import { computeConfidence } from './confidence.ts';
import { ungroundedNumbers } from './grounding.ts';
import {
  HypothesisBoard,
  ProposeHypothesesInput,
  coverageRules,
  renderBoard,
  resolveChecks,
  validateProposal,
} from './hypotheses.ts';
import {
  ChallengeInput,
  Investigation,
  type InvestigationEvent,
  type Role,
  type SkepticReport,
  type VerificationRound,
} from './investigation.ts';
import { Ledger, LedgerError } from './ledger.ts';
import type {
  Effort,
  LlmClient,
  LlmMessage,
  LlmToolResult,
  LlmToolSpec,
  LlmToolUse,
} from './llm/types.ts';
import { UsageMeter } from './llm/usage.ts';
import { loadPrompt } from './prompts.ts';
import { ToolContext } from './tools/context.ts';
import { DATA_TOOLS } from './tools/registry.ts';
import { ToolRunner, isDataTool, toolSpecs } from './tools/runner.ts';
import { callKey } from './tools/types.ts';
import { DiagnosisDraft, checkClaim, verifyDeterministic } from './verifier.ts';

export class InvestigationError extends Error {}

export interface InvestigateOptions {
  store: TelemetryStore;
  incidentId: string;
  llm: LlmClient;
  model: string;
  verifierModel?: string;
  effort?: Effort;
  /** Hard cap on all tokens read or written by the models in this investigation. */
  maxTokens: number;
  onEvent?: (event: InvestigationEvent) => void;
  limits?: Partial<Limits>;
}

export interface Limits {
  /** New tool queries the skeptic must run. */
  skepticMinNewQueries: number;
  /** Times the diagnosis may be sent back before it is published with open issues. */
  maxRevisionRounds: number;
  investigatorMaxTurns: number;
  skepticMaxTurns: number;
  /** Rejected structured inputs (hypotheses, challenge, malformed diagnosis) tolerated per kind. */
  maxRejectedInputs: number;
  maxOutputTokens: number;
}

const DEFAULT_LIMITS: Limits = {
  skepticMinNewQueries: 3,
  maxRevisionRounds: 2,
  investigatorMaxTurns: 45,
  skepticMaxTurns: 25,
  maxRejectedInputs: 4,
  maxOutputTokens: 16_000,
};

// ---- Control tools ----------------------------------------------------------------------------

const RecordInferenceInput = z.strictObject({
  statement: z.string().min(1),
  rule: z.string().min(1),
  premises: z.array(z.string().min(1)).min(1),
});

const VerdictInput = z.strictObject({
  claims: z
    .array(
      z.strictObject({ location: z.string().min(1), supported: z.boolean(), reason: z.string() }),
    )
    .min(1),
});

const RECORD_INFERENCE = {
  name: 'record_inference',
  description:
    'Record a conclusion drawn from facts, so you can cite it. Arguments: statement (no numbers unless they appear in the premises), rule (a short name for the reasoning step, e.g. "onset-order"), premises (IDs of FACT or INFERENCE entries; never a hypothesis). Returns the new entry ID.',
  input: RecordInferenceInput,
};
const PROPOSE_HYPOTHESES = {
  name: 'propose_hypotheses',
  description:
    'Propose 3 to 5 competing hypotheses, each with a kind and at least 2 predictions. A prediction names a finding of a data tool call (tool, args, findingKey) and the expected value (op "is" by default, or "is_not"). Every pair of hypotheses should be discriminated by a prediction on the SAME finding with different expected values. The engine runs every prediction, scores the hypotheses, has a skeptic challenge the leading one, and returns all of it.',
  input: ProposeHypothesesInput,
};
const SUBMIT_DIAGNOSIS = {
  name: 'submit_diagnosis',
  description:
    'Submit the diagnosis for verification. rootCause: the structural mechanism (not the symptom, not the remedy), the hypothesisId it corresponds to, and supporting ledger entries. causalChain: at least 2 ordered steps, each with ledgerEntryIds and an onsetEntryId (a dated FACT among them). rejectedHypotheses: every hypothesis the tests rejected, with the contradicting fact. recommendations: at least one, each with a replay patch and addresses = "cause" | "symptom". followUps: fixes that need a human (e.g. a code change). unknowns: what could not be determined. If verification fails you receive the issues and may resubmit.',
  input: DiagnosisDraft,
};
const SUBMIT_CHALLENGE = {
  name: 'submit_challenge',
  description:
    "Submit your challenge after running your new queries. againstLeading: challenges to the leading hypothesis, each citing at least one fact from YOUR new queries, with verdict holds | weakened | refuted. strongestAlternative: hypothesisId of an existing alternative OR newHypothesis (same form as the investigator's), your argument for it, and checks citing facts from your new queries with verdict supports_alternative | contradicts_alternative | inconclusive. redHerrings: changes or earlier anomalies near the incident, each not_causal | possibly_causal with facts. temporalPrecedence: consistent | violated | inconclusive with facts.",
  input: ChallengeInput,
};
const SUBMIT_VERDICT = {
  name: 'submit_verdict',
  description:
    'Submit your judgment: one entry per claim with its location (rootCause, causalChain[i], rejectedHypotheses[i], recommendations[i], followUps[i]), whether the cited entries support it, and for unsupported claims a one-sentence reason without numbers.',
  input: VerdictInput,
};

interface Handled {
  content: string;
  isError?: boolean;
  done?: boolean;
}

const zodProblems = (e: z.ZodError): string[] =>
  e.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);

const json = (x: unknown): string => JSON.stringify(x);

export async function investigate(opts: InvestigateOptions): Promise<Investigation> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const effort: Effort = opts.effort ?? 'medium';
  const verifierModel = opts.verifierModel ?? opts.model;
  const emit = (e: InvestigationEvent): void => opts.onEvent?.(e);

  const ctx = new ToolContext(opts.store, opts.incidentId);
  const ledger = new Ledger();
  const runner = new ToolRunner(ctx, ledger);
  const board = new HypothesisBoard();
  const meter = new UsageMeter(opts.maxTokens);
  const warnings: string[] = [];
  const answeredBy = new Set<string>();
  const verification: VerificationRound[] = [];
  let skeptic: SkepticReport | null = null;
  let revisionRounds = 0;
  let published: { draft: DiagnosisDraft; unresolved: VerifierIssue[] } | null = null;

  // ---- Generic tool loop ----------------------------------------------------------------------

  async function runAgent(a: {
    role: Role;
    model: string;
    system: string;
    messages: LlmMessage[];
    tools: LlmToolSpec[];
    handle: (name: string, input: unknown) => Promise<Handled>;
    finishWith: string;
    maxTurns: number;
  }): Promise<'done' | 'gave_up'> {
    let nudges = 0;
    for (let turn = 0; turn < a.maxTurns; turn++) {
      meter.assertWithinBudget(a.role);
      const res = await opts.llm.complete({
        model: a.model,
        system: a.system,
        messages: a.messages,
        tools: a.tools,
        maxTokens: limits.maxOutputTokens,
        effort,
      });
      meter.add(a.role, res.model, res.usage);
      answeredBy.add(res.model);
      if (res.model !== a.model)
        warnings.push(
          `A ${a.role} request for ${a.model} was answered by ${res.model} (server-side fallback).`,
        );
      emit({
        type: 'usage',
        role: a.role,
        totalTokens: meter.totalTokens,
        budgetTokens: meter.budgetTokens,
      });
      // The assistant turn goes back unchanged (thinking blocks included): append-only history.
      a.messages.push({ role: 'assistant', content: res.content });
      const uses = res.content.filter((b): b is LlmToolUse => b.type === 'tool_use');
      if (uses.length === 0) {
        if (++nudges > 3) return 'gave_up';
        a.messages.push({
          role: 'user',
          content:
            res.stopReason === 'max_tokens'
              ? `Your last message was cut off before any tool call. Be brief and call a tool; finish by calling ${a.finishWith}.`
              : `Nothing is finished until you call a tool. Continue with the data tools if you need more evidence, then call ${a.finishWith}.`,
        });
        continue;
      }
      const results: LlmToolResult[] = [];
      let done = false;
      for (const use of uses) {
        const h = await a.handle(use.name, use.input);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: h.content,
          ...(h.isError === true ? { is_error: true } : {}),
        });
        done ||= h.done === true;
      }
      // All results of one turn go back in ONE user message.
      a.messages.push({ role: 'user', content: results });
      if (done) return 'done';
    }
    return 'gave_up';
  }

  /** Data tools and record_inference, shared by investigator and skeptic. */
  function handleCommon(
    role: 'investigator' | 'skeptic',
    name: string,
    input: unknown,
    onNewCall?: (key: string, factIds: string[]) => void,
  ): Handled | null {
    if (isDataTool(name)) {
      const run = runner.run(role, name, input);
      if (!run.ok) {
        emit({ type: 'tool', role, tool: name, args: {}, ok: false, summary: run.error, facts: 0 });
        return { content: run.error, isError: true };
      }
      onNewCall?.(
        run.callKey,
        run.facts.map((f) => f.id),
      );
      emit({
        type: 'tool',
        role,
        tool: name,
        args: run.args,
        ok: true,
        summary: run.output.summary,
        facts: run.facts.length,
      });
      return { content: run.text };
    }
    if (name === RECORD_INFERENCE.name) {
      const parsed = RecordInferenceInput.safeParse(input);
      if (!parsed.success)
        return { content: `invalid input: ${zodProblems(parsed.error).join('; ')}`, isError: true };
      const existing = parsed.data.premises.filter((p) => ledger.get(p) !== undefined);
      const bad = ungroundedNumbers(parsed.data.statement, ledger.factsBehind(existing));
      if (bad.length > 0) {
        return {
          content: `not recorded: number(s) ${bad.join(', ')} do not appear in the facts behind the premises. Restate without them or add the fact that contains them as a premise.`,
          isError: true,
        };
      }
      try {
        const e = ledger.addInference(
          role,
          parsed.data.statement,
          parsed.data.rule,
          parsed.data.premises,
        );
        emit({ type: 'inference', role, id: e.id, statement: e.statement });
        return { content: json({ id: e.id, type: 'INFERENCE' }) };
      } catch (err) {
        if (err instanceof LedgerError)
          return { content: `not recorded: ${err.message}`, isError: true };
        throw err;
      }
    }
    return null;
  }

  // ---- Skeptic --------------------------------------------------------------------------------

  async function runSkeptic(leading: Hypothesis): Promise<SkepticReport | null> {
    emit({ type: 'stage', stage: 'skeptic', detail: leading.title });
    const before = new Set(runner.calls.map((c) => c.callKey));
    const newCalls = new Set<string>();
    const newFactIds = new Set<string>();
    let rejected = 0;
    let report: SkepticReport | null = null;
    const fact = (id: string | undefined): string | null => {
      const e = id === undefined ? undefined : ledger.get(id);
      return e === undefined ? null : `${e.id}: ${e.statement}`;
    };
    const brief = {
      incident: opts.incidentId,
      leadingHypothesis: {
        id: leading.id,
        kind: leading.kind,
        title: leading.title,
        statement: leading.statement,
        predictions: leading.predictions.map((p) => ({
          statement: p.statement,
          result: p.result,
          note: p.note,
          fact: fact(p.ledgerEntryIds[0]),
        })),
      },
      otherHypotheses: board.hypotheses
        .filter((h) => h.id !== leading.id)
        .map((h) => ({
          id: h.id,
          kind: h.kind,
          title: h.title,
          statement: h.statement,
          status: h.status,
          predictions: h.predictions.map((p) => ({
            statement: p.statement,
            result: p.result,
            note: p.note,
            fact: fact(p.ledgerEntryIds[0]),
          })),
        })),
      queriesAlreadyRun: [...before],
      required: `Run at least ${String(limits.skepticMinNewQueries)} tool queries that are not in queriesAlreadyRun, then call submit_challenge.`,
    };
    const usesNew = (ids: readonly string[]): boolean =>
      ledger.factsBehind(ids).some((f) => newFactIds.has(f.id));

    const outcome = await runAgent({
      role: 'skeptic',
      model: opts.model,
      system: loadPrompt('skeptic'),
      messages: [{ role: 'user', content: json(brief) }],
      tools: toolSpecs([...DATA_TOOLS, RECORD_INFERENCE, SUBMIT_CHALLENGE]),
      finishWith: SUBMIT_CHALLENGE.name,
      maxTurns: limits.skepticMaxTurns,
      handle: (name, input) => {
        const common = handleCommon('skeptic', name, input, (key, factIds) => {
          if (!before.has(key)) {
            newCalls.add(key);
            for (const id of factIds) newFactIds.add(id);
          }
        });
        if (common !== null) return Promise.resolve(common);
        if (name !== SUBMIT_CHALLENGE.name)
          return Promise.resolve({ content: `unknown tool "${name}"`, isError: true });

        const parsed = ChallengeInput.safeParse(input);
        const problems: string[] = parsed.success ? [] : zodProblems(parsed.error);
        if (parsed.success) {
          const c = parsed.data;
          if (newCalls.size < limits.skepticMinNewQueries) {
            problems.push(
              `you ran ${String(newCalls.size)} new tool queries; at least ${String(limits.skepticMinNewQueries)} are required (queries not in queriesAlreadyRun)`,
            );
          }
          const claims: [string, string, readonly string[]][] = [
            ...c.againstLeading.map((x, i): [string, string, readonly string[]] => [
              `againstLeading[${String(i)}]`,
              x.statement,
              x.ledgerEntryIds,
            ]),
            ...c.strongestAlternative.checks.map((x, i): [string, string, readonly string[]] => [
              `strongestAlternative.checks[${String(i)}]`,
              x.statement,
              x.ledgerEntryIds,
            ]),
            ...c.redHerrings.map((x, i): [string, string, readonly string[]] => [
              `redHerrings[${String(i)}]`,
              x.reason,
              x.ledgerEntryIds,
            ]),
            [
              'temporalPrecedence',
              c.temporalPrecedence.statement,
              c.temporalPrecedence.ledgerEntryIds,
            ],
            [
              'strongestAlternative.argument',
              c.strongestAlternative.argument,
              c.strongestAlternative.checks.flatMap((x) => x.ledgerEntryIds),
            ],
          ];
          for (const [at, text, ids] of claims) {
            for (const i of checkClaim(ledger, at, text, ids))
              problems.push(`${i.location}: ${i.message}`);
          }
          if (!c.againstLeading.some((x) => usesNew(x.ledgerEntryIds)))
            problems.push(
              'againstLeading: at least one challenge must cite a fact from one of your new queries',
            );
          if (!c.strongestAlternative.checks.some((x) => usesNew(x.ledgerEntryIds)))
            problems.push(
              'strongestAlternative.checks: at least one check must cite a fact from one of your new queries',
            );
          const alt = c.strongestAlternative;
          if ((alt.hypothesisId === undefined) === (alt.newHypothesis === undefined)) {
            problems.push(
              'strongestAlternative: give exactly one of hypothesisId or newHypothesis',
            );
          } else if (alt.hypothesisId !== undefined) {
            if (board.get(alt.hypothesisId) === undefined)
              problems.push(`strongestAlternative: hypothesis ${alt.hypothesisId} does not exist`);
            else if (alt.hypothesisId === leading.id)
              problems.push(
                'strongestAlternative: must be a hypothesis other than the leading one',
              );
          }
          const resolved =
            alt.newHypothesis === undefined ? null : resolveChecks(alt.newHypothesis);
          if (resolved !== null)
            problems.push(
              ...resolved.problems.map((p) => `strongestAlternative.newHypothesis.${p}`),
            );

          if (problems.length === 0) {
            let altId = alt.hypothesisId ?? '';
            if (alt.newHypothesis !== undefined && resolved !== null) {
              const [added] = board.addAndTest(
                [alt.newHypothesis],
                [resolved.checks],
                'skeptic',
                runner,
                ledger,
              );
              altId = added?.id ?? '';
            }
            report = {
              leadingHypothesisId: leading.id,
              alternativeHypothesisId: altId,
              newQueries: [...newCalls],
              againstLeading: c.againstLeading,
              alternativeArgument: alt.argument,
              alternativeChecks: alt.checks,
              redHerrings: c.redHerrings,
              temporalPrecedence: c.temporalPrecedence,
            };
            emit({ type: 'skeptic', report });
            return Promise.resolve({ content: 'challenge recorded', done: true });
          }
        }
        emit({ type: 'rejected_input', role: 'skeptic', tool: SUBMIT_CHALLENGE.name, problems });
        if (++rejected >= limits.maxRejectedInputs)
          return Promise.resolve({
            content: 'challenge rejected too many times',
            isError: true,
            done: true,
          });
        return Promise.resolve({
          content: `challenge not accepted:\n- ${problems.join('\n- ')}`,
          isError: true,
        });
      },
    });
    if (report === null)
      warnings.push(
        `The skeptic did not produce a valid challenge (${outcome === 'gave_up' ? 'it stopped calling tools' : 'its submissions were rejected'}).`,
      );
    return report;
  }

  // ---- LLM logic pass of the verifier -----------------------------------------------------------

  async function llmVerify(
    draft: DiagnosisDraft,
  ): Promise<{ pass: 'ran' | 'no_verdict'; issues: VerifierIssue[] }> {
    const citedIds = new Set<string>([
      ...draft.rootCause.ledgerEntryIds,
      ...draft.causalChain.flatMap((s) => s.ledgerEntryIds),
      ...draft.rejectedHypotheses.flatMap((r) => r.ledgerEntryIds),
      ...draft.recommendations.flatMap((r) => r.ledgerEntryIds),
      ...draft.followUps.flatMap((r) => r.ledgerEntryIds),
    ]);
    // Include the premises of cited inferences so the reviewer sees what they rest on.
    const entries = new Map<string, LedgerEntry>();
    const stack = [...citedIds];
    while (stack.length > 0) {
      const e = ledger.get(stack.pop() as string);
      if (e === undefined || entries.has(e.id)) continue;
      entries.set(e.id, e);
      if (e.type === 'INFERENCE') stack.push(...e.premises);
    }
    const payload = {
      diagnosis: draft,
      citedEntries: [...entries.values()].map((e) => ({
        id: e.id,
        type: e.type,
        statement: e.statement,
        ...(e.type === 'INFERENCE' ? { rule: e.rule, premises: e.premises } : {}),
      })),
      hypotheses: renderBoard(board.hypotheses),
    };
    let verdict: z.infer<typeof VerdictInput> | null = null;
    await runAgent({
      role: 'verifier',
      model: verifierModel,
      system: loadPrompt('verifier'),
      messages: [{ role: 'user', content: json(payload) }],
      tools: toolSpecs([SUBMIT_VERDICT]),
      finishWith: SUBMIT_VERDICT.name,
      maxTurns: 4,
      handle: (name, input) => {
        if (name !== SUBMIT_VERDICT.name)
          return Promise.resolve({ content: `unknown tool "${name}"`, isError: true });
        const parsed = VerdictInput.safeParse(input);
        if (!parsed.success)
          return Promise.resolve({
            content: `invalid input: ${zodProblems(parsed.error).join('; ')}`,
            isError: true,
          });
        verdict = parsed.data;
        return Promise.resolve({ content: 'verdict recorded', done: true });
      },
    });
    const v = verdict as z.infer<typeof VerdictInput> | null;
    if (v === null) return { pass: 'no_verdict', issues: [] };
    const allFacts = ledger.factsBehind([...entries.keys()]);
    return {
      pass: 'ran',
      issues: v.claims
        .filter((c) => !c.supported)
        .map((c) => ({
          code: 'unsupported_logic' as const,
          location: c.location,
          // The reviewer's words reach the user, so they are held to the same number rule.
          message:
            ungroundedNumbers(c.reason, allFacts).length > 0 || c.reason.trim() === ''
              ? 'The reviewer judged that the cited entries do not support this claim (its explanation was withheld because it contained numbers that are not in the cited facts).'
              : `Reviewer: ${c.reason}`,
          ledgerEntryIds: [],
        })),
    };
  }

  // ---- Investigator ---------------------------------------------------------------------------

  let proposalRounds = 0;
  let rejectedProposals = 0;
  let rejectedDrafts = 0;

  async function handleProposal(input: unknown): Promise<Handled> {
    if (proposalRounds >= 2)
      return {
        content: 'hypotheses were already proposed and tested twice; call submit_diagnosis',
        isError: true,
      };
    if (proposalRounds === 1 && board.leading() !== null) {
      return {
        content:
          'hypotheses were already proposed and tested; use the results and call submit_diagnosis',
        isError: true,
      };
    }
    const parsed = ProposeHypothesesInput.safeParse(input);
    const check = parsed.success ? validateProposal(parsed.data, coverageRules(ctx)) : null;
    const problems = parsed.success ? (check?.problems ?? []) : zodProblems(parsed.error);
    if (!parsed.success || check === null || problems.length > 0) {
      emit({
        type: 'rejected_input',
        role: 'investigator',
        tool: PROPOSE_HYPOTHESES.name,
        problems,
      });
      if (++rejectedProposals >= limits.maxRejectedInputs)
        throw new InvestigationError(
          `the investigator could not produce a valid set of hypotheses: ${problems.join('; ')}`,
        );
      return { content: `proposal not accepted:\n- ${problems.join('\n- ')}`, isError: true };
    }
    proposalRounds++;
    warnings.push(...check.warnings);
    emit({ type: 'stage', stage: 'testing_hypotheses' });
    board.addAndTest(parsed.data.hypotheses, check.checks, 'investigator', runner, ledger);
    const leading = board.leading();
    emit({
      type: 'hypotheses',
      hypotheses: board.hypotheses,
      leadingHypothesisId: leading?.id ?? null,
    });
    if (leading === null) {
      return {
        content: json({
          tested: renderBoard(board.hypotheses),
          leadingHypothesisId: null,
          next:
            proposalRounds < 2
              ? 'Every hypothesis was rejected by its tests. Look at the contradicting facts, gather more evidence, and propose a new set with propose_hypotheses.'
              : 'Every hypothesis was rejected. No root cause can be supported.',
        }),
      };
    }
    skeptic = await runSkeptic(leading);
    emit({ type: 'stage', stage: 'investigating', detail: 'diagnosis' });
    return {
      content: json({
        tested: renderBoard(board.hypotheses),
        leadingHypothesisId: board.leading()?.id ?? null,
        skeptic: skeptic ?? 'The skeptic did not produce a valid challenge.',
        next: "Weigh the skeptic's challenge, run any further queries you need, then call submit_diagnosis. Every rejected hypothesis must be listed with the fact that contradicted it.",
      }),
    };
  }

  async function handleDiagnosis(input: unknown): Promise<Handled> {
    if (board.hypotheses.length === 0)
      return { content: 'propose and test hypotheses first (propose_hypotheses)', isError: true };
    const parsed = DiagnosisDraft.safeParse(input);
    if (!parsed.success) {
      const problems = zodProblems(parsed.error);
      emit({ type: 'rejected_input', role: 'investigator', tool: SUBMIT_DIAGNOSIS.name, problems });
      if (++rejectedDrafts >= limits.maxRejectedInputs)
        throw new InvestigationError(
          `the investigator could not produce a well-formed diagnosis: ${problems.join('; ')}`,
        );
      return {
        content: `diagnosis is malformed (this does not count as a revision round):\n- ${problems.join('\n- ')}`,
        isError: true,
      };
    }
    const draft = parsed.data;
    emit({ type: 'stage', stage: 'verifying', detail: `round ${String(verification.length)}` });
    const deterministicIssues = verifyDeterministic({
      store: opts.store,
      incidentId: opts.incidentId,
      ledger,
      hypotheses: board.hypotheses,
      draft,
    });
    let llmPass: VerificationRound['llmPass'] = 'not_reached';
    let llmIssues: VerifierIssue[] = [];
    if (deterministicIssues.length === 0) {
      const r = await llmVerify(draft);
      llmPass = r.pass;
      llmIssues = r.issues;
      if (r.pass === 'no_verdict')
        warnings.push(
          "The verifier's LLM logic pass returned no verdict; only the deterministic checks were applied in that round.",
        );
    }
    const round: VerificationRound = {
      round: verification.length,
      deterministicIssues,
      llmPass,
      llmIssues,
    };
    verification.push(round);
    const issues = [...deterministicIssues, ...llmIssues];
    const accepted = issues.length === 0;
    emit({ type: 'verification', round, accepted });
    if (accepted) {
      published = { draft, unresolved: [] };
      return { content: 'diagnosis verified and published', done: true };
    }
    if (revisionRounds >= limits.maxRevisionRounds) {
      published = { draft, unresolved: issues };
      return { content: 'published with unresolved issues listed', done: true };
    }
    revisionRounds++;
    return {
      content: `verification failed (revision round ${String(revisionRounds)} of ${String(limits.maxRevisionRounds)}). Fix these and call submit_diagnosis again:\n- ${issues.map((i) => `[${i.code}] ${i.location}: ${i.message}`).join('\n- ')}`,
      isError: true,
    };
  }

  emit({ type: 'stage', stage: 'investigating' });
  const outcome = await runAgent({
    role: 'investigator',
    model: opts.model,
    system: loadPrompt('investigator'),
    messages: [
      {
        role: 'user',
        content: `Investigate incident ${opts.incidentId}. Start with get_incident_window.`,
      },
    ],
    tools: toolSpecs([...DATA_TOOLS, RECORD_INFERENCE, PROPOSE_HYPOTHESES, SUBMIT_DIAGNOSIS]),
    finishWith: `${PROPOSE_HYPOTHESES.name} and then ${SUBMIT_DIAGNOSIS.name}`,
    maxTurns: limits.investigatorMaxTurns,
    handle: (name, input) => {
      const common = handleCommon('investigator', name, input);
      if (common !== null) return Promise.resolve(common);
      if (name === PROPOSE_HYPOTHESES.name) return handleProposal(input);
      if (name === SUBMIT_DIAGNOSIS.name) return handleDiagnosis(input);
      return Promise.resolve({ content: `unknown tool "${name}"`, isError: true });
    },
  });
  if (outcome === 'gave_up')
    warnings.push('The investigator stopped before a diagnosis was verified.');

  // ---- Assemble -------------------------------------------------------------------------------

  const final = published as { draft: DiagnosisDraft; unresolved: VerifierIssue[] } | null;
  const root =
    final === null
      ? undefined
      : (board.get(final.draft.rootCause.hypothesisId) ?? board.leading() ?? undefined);
  let diagnosis: Diagnosis | null = null;
  if (final !== null && root !== undefined) {
    const services = ctx.incident.services;
    const confidence = computeConfidence(root, board.hypotheses, skeptic, final.unresolved);
    const candidate = Diagnosis.safeParse({
      rootCause: { ...final.draft.rootCause, hypothesisId: root.id, kind: root.kind },
      causalChain: final.draft.causalChain.map((s) => {
        const { service, ...rest } = s;
        return service !== undefined && services.includes(service) ? { ...rest, service } : rest;
      }),
      affectedServices: final.draft.affectedServices.filter((s) => services.includes(s)),
      rejectedHypotheses: final.draft.rejectedHypotheses.flatMap((r) => {
        const h = board.get(r.hypothesisId);
        return h === undefined ? [] : [{ ...r, title: h.title }];
      }),
      confidence,
      unknowns: final.draft.unknowns,
      recommendations: final.draft.recommendations.map((r, i) => ({
        id: `rc_${(i + 1).toString(36)}`,
        ...r,
      })),
      followUps: final.draft.followUps,
      unresolvedIssues: final.unresolved,
    });
    if (candidate.success) diagnosis = candidate.data;
    else
      warnings.push(
        `The final diagnosis could not be published because it is malformed: ${zodProblems(candidate.error).join('; ')}`,
      );
  } else if (final !== null) {
    warnings.push('No hypothesis survived its tests, so no root cause can be named.');
  }

  emit({ type: 'stage', stage: 'done' });
  return Investigation.parse({
    formatVersion: 1,
    incidentId: opts.incidentId,
    outcome: diagnosis === null ? 'inconclusive' : 'diagnosed',
    llm: {
      mode: opts.llm.mode,
      recorded: opts.llm.mode === 'replay',
      model: opts.model,
      verifierModel,
      effort,
      answeredBy: [...answeredBy].sort(),
    },
    usage: meter.summary(),
    hypotheses: board.hypotheses,
    leadingHypothesisId: board.leading()?.id ?? null,
    skeptic,
    verification,
    revisionRounds,
    ledger: ledger.entries,
    diagnosis,
    confidence: diagnosis?.confidence ?? null,
    warnings: [...new Set(warnings)],
  });
}

export { callKey };
