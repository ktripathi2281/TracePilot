// `tracepilot investigate --incident <id> [--stream]` (brief §9).
//
// Runs the investigation against the telemetry store, prints the diagnosis, and saves the full
// record (ledger, hypotheses, skeptic, verification rounds, usage) to
// <out>/investigations/<incidentId>.json. Reads the store only: the simulator-side recording in
// <out>/sim/ is never opened here.
//
// Exit codes (exit.ts): 0 verified diagnosis; 1 no diagnosis (inconclusive, budget, API or
// cassette error); 2 a diagnosis published with unresolved verifier issues; 64 bad input.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BudgetExceededError,
  CassetteMissError,
  InvestigationError,
  LlmRefusalError,
  LoggingLlm,
  cassettePath,
  createLlmClient,
  describeLlmError,
  fmtT,
  investigate,
  llmConfigFromEnv,
  type Investigation,
  type InvestigationEvent,
  type LlmClient,
} from '@tracepilot/agents';
import { formatPatch, type LedgerEntry } from '@tracepilot/schema';
import { TelemetryStore } from '@tracepilot/store';
import { EXIT } from './exit.ts';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const INVESTIGATIONS_DIR = 'investigations';
export const LLM_LOG_DIR = 'llm-logs';
export const STORE_FILE = 'telemetry.db';

/** Request/response log of the LLM calls of an investigation (appended on every run). */
export const llmLogPath = (outDir: string, incidentId: string): string =>
  join(outDir, LLM_LOG_DIR, `${incidentId}.jsonl`);

export function investigationPath(outDir: string, incidentId: string): string {
  return join(outDir, INVESTIGATIONS_DIR, `${incidentId}.json`);
}

function streamLine(e: InvestigationEvent): string | null {
  switch (e.type) {
    case 'stage':
      return e.stage === 'done'
        ? null
        : `── ${e.stage.replace('_', ' ')}${e.detail === undefined ? '' : `: ${e.detail}`}`;
    case 'tool':
      return `   ${e.role.padEnd(12)} ${e.ok ? '✓' : '✗'} ${e.tool}${Object.keys(e.args).length === 0 ? '' : ` ${JSON.stringify(e.args)}`} → ${e.summary}`;
    case 'inference':
      return `   ${e.role.padEnd(12)} + ${e.id} ${e.statement}`;
    case 'hypotheses':
      return e.hypotheses
        .map((h) => {
          const n = (r: string): number => h.predictions.filter((p) => p.result === r).length;
          return `   ${h.id === e.leadingHypothesisId ? '▶' : ' '} ${h.id} [${h.status}] ${h.title} (${h.kind}): ${String(n('supported'))} supported, ${String(n('contradicted'))} contradicted, ${String(n('inconclusive'))} inconclusive`;
        })
        .join('\n');
    case 'rejected_input':
      return `   ${e.role.padEnd(12)} ✗ ${e.tool} sent back: ${e.problems.slice(0, 3).join(' | ')}`;
    case 'skeptic':
      return `   skeptic      ${String(e.report.newQueries.length)} new queries; against leading: ${e.report.againstLeading.map((c) => c.verdict).join(', ')}; alternative ${e.report.alternativeHypothesisId}: ${e.report.alternativeChecks.map((c) => c.verdict).join(', ')}; precedence ${e.report.temporalPrecedence.verdict}`;
    case 'verification': {
      const issues = [...e.round.deterministicIssues, ...e.round.llmIssues];
      return `   verifier     round ${String(e.round.round)}: ${e.accepted ? 'passed' : `${String(issues.length)} issue(s)`}${issues
        .slice(0, 5)
        .map((i) => `\n                  [${i.code}] ${i.location}: ${i.message}`)
        .join('')}`;
    }
    case 'usage':
      return null;
  }
}

/** The diagnosis as text. Every number printed here is from a fact statement, the rubric or the API usage report. */
export function renderInvestigation(inv: Investigation): string[] {
  const lines: string[] = [];
  const entries = new Map<string, LedgerEntry>(inv.ledger.map((e) => [e.id, e]));
  const cite = (ids: readonly string[], indent: string): string[] =>
    ids.map((id) => `${indent}${id}  ${entries.get(id)?.statement ?? '(missing entry)'}`);
  const badge = inv.llm.recorded
    ? '  [Recorded run: replayed from a cassette]'
    : inv.llm.mode === 'scripted'
      ? '  [Scripted test double: not a model run]'
      : '';
  lines.push(`Incident ${inv.incidentId}   model ${inv.llm.model}   mode ${inv.llm.mode}${badge}`);
  const d = inv.diagnosis;
  if (d === null) {
    lines.push('', 'No diagnosis could be published.');
  } else {
    lines.push(
      '',
      `ROOT CAUSE (${d.rootCause.kind}, hypothesis ${d.rootCause.hypothesisId})`,
      `  ${d.rootCause.statement}`,
      ...cite(d.rootCause.ledgerEntryIds, '    '),
    );
    const b = d.confidence.basis;
    lines.push(
      '',
      `CONFIDENCE ${d.confidence.level} (${String(d.confidence.score)}): ${String(b.supportedPredictions)} predictions supported, ${String(b.contradictedPredictions)} contradicted, ${String(b.inconclusivePredictions)} inconclusive, ${String(b.unresolvedContradictions)} unresolved contradictions`,
    );
    lines.push('', 'CAUSAL CHAIN');
    d.causalChain.forEach((s, i) => {
      const onset = entries.get(s.onsetEntryId);
      const at =
        onset?.type === 'FACT' && onset.occurredAt !== undefined
          ? fmtT(onset.occurredAt.tsUs)
          : '?';
      lines.push(
        `  ${String(i + 1)}. [${at}] ${s.statement}`,
        ...cite(s.ledgerEntryIds, '       '),
      );
    });
    lines.push('', `AFFECTED SERVICES  ${d.affectedServices.join(', ')}`);
    if (d.rejectedHypotheses.length > 0) {
      lines.push('', 'REJECTED HYPOTHESES');
      for (const r of d.rejectedHypotheses)
        lines.push(`  ✗ ${r.title}: ${r.reason}`, ...cite(r.ledgerEntryIds, '       '));
    }
    lines.push('', 'RECOMMENDATIONS (try them in replay; TracePilot changes nothing)');
    for (const r of d.recommendations)
      lines.push(
        `  ${r.id} [addresses ${r.addresses}] ${r.title}   patch: ${formatPatch(r.patch)}`,
        `       ${r.rationale}`,
      );
    for (const f of d.followUps) lines.push(`  follow-up: ${f.title}`, `       ${f.rationale}`);
    if (d.unknowns.length > 0) lines.push('', 'UNKNOWNS', ...d.unknowns.map((u) => `  - ${u}`));
    if (d.unresolvedIssues.length > 0) {
      lines.push(
        '',
        `UNRESOLVED VERIFIER ISSUES (published after ${String(inv.revisionRounds)} revision rounds)`,
      );
      for (const i of d.unresolvedIssues) lines.push(`  ! [${i.code}] ${i.location}: ${i.message}`);
    }
  }
  if (inv.skeptic !== null) {
    lines.push('', `SKEPTIC (${String(inv.skeptic.newQueries.length)} new queries)`);
    for (const c of inv.skeptic.againstLeading) lines.push(`  ${c.verdict}: ${c.statement}`);
    lines.push(
      `  strongest alternative ${inv.skeptic.alternativeHypothesisId}: ${inv.skeptic.alternativeArgument}`,
    );
    for (const c of inv.skeptic.alternativeChecks) lines.push(`    ${c.verdict}: ${c.statement}`);
    for (const r of inv.skeptic.redHerrings)
      lines.push(`  red herring ${r.subject}: ${r.verdict}. ${r.reason}`);
    lines.push(
      `  temporal precedence ${inv.skeptic.temporalPrecedence.verdict}: ${inv.skeptic.temporalPrecedence.statement}`,
    );
  }
  const lastRound = inv.verification.at(-1);
  lines.push(
    '',
    `VERIFIER  ${String(inv.verification.length)} round(s), ${String(inv.revisionRounds)} revision(s); last round: ${lastRound === undefined ? 'not reached' : lastRound.deterministicIssues.length + lastRound.llmIssues.length === 0 ? 'passed' : 'issues remain'}`,
  );
  for (const w of inv.warnings) lines.push(`  note: ${w}`);
  const u = inv.usage;
  lines.push(
    `USAGE  ${String(u.calls)} LLM calls, ${String(u.totalTokens)} of ${String(u.budgetTokens)} budget tokens${u.estimatedCostUsd === null ? '' : `, about $${u.estimatedCostUsd.toFixed(2)} at list prices`}`,
  );
  return lines;
}

export interface InvestigateDeps {
  /** Test seam: supply the LLM client instead of building one from the environment. */
  llm?: LlmClient;
  env?: Readonly<Record<string, string | undefined>>;
}

export async function investigateCommand(
  args: string[],
  io: Io,
  deps: InvestigateDeps = {},
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      incident: { type: 'string' },
      out: { type: 'string', default: '.data' },
      stream: { type: 'boolean', default: false },
    },
  });
  if (values.incident === undefined) {
    io.err('investigate: --incident is required (sim run prints the incident ID)');
    return EXIT.usage;
  }
  let config;
  try {
    config = llmConfigFromEnv(deps.env ?? process.env, values.out);
  } catch (e) {
    io.err(`investigate: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.usage;
  }
  const store = new TelemetryStore(join(values.out, STORE_FILE));
  try {
    if (!store.listIncidents().some((i) => i.id === values.incident)) {
      io.err(`investigate: no incident ${values.incident} in ${join(values.out, STORE_FILE)}`);
      return EXIT.usage;
    }
    const llm = new LoggingLlm(
      deps.llm ?? createLlmClient(config, values.incident),
      llmLogPath(values.out, values.incident),
    );
    if (config.mode !== 'live' && deps.llm === undefined)
      io.out(`LLM mode ${config.mode}, cassette ${cassettePath(config, values.incident)}`);
    const inv = await investigate({
      store,
      incidentId: values.incident,
      llm,
      model: config.model,
      verifierModel: config.verifierModel,
      effort: config.effort,
      maxTokens: config.maxTokensPerInvestigation,
      ...(values.stream
        ? {
            onEvent: (e: InvestigationEvent): void => {
              const line = streamLine(e);
              if (line !== null) io.out(line);
            },
          }
        : {}),
    });
    mkdirSync(join(values.out, INVESTIGATIONS_DIR), { recursive: true });
    writeFileSync(
      investigationPath(values.out, values.incident),
      `${JSON.stringify(inv, null, 1)}\n`,
    );
    if (values.stream) io.out('');
    for (const line of renderInvestigation(inv)) io.out(line);
    io.out(`saved  ${investigationPath(values.out, values.incident)}`);
    io.out(`llm log ${llmLogPath(values.out, values.incident)}`);
    if (inv.outcome !== 'diagnosed') return 1;
    const open = inv.diagnosis?.unresolvedIssues.length ?? 0;
    if (open > 0) {
      io.err(
        `investigate: the diagnosis was published with ${String(open)} unresolved verifier issue(s); it is not verified`,
      );
      return EXIT.unverified;
    }
    return 0;
  } catch (e) {
    const known =
      e instanceof CassetteMissError ||
      e instanceof BudgetExceededError ||
      e instanceof InvestigationError ||
      e instanceof LlmRefusalError
        ? e.message
        : describeLlmError(e);
    if (known === null) throw e;
    io.err(`investigate: ${known}`);
    return 1;
  } finally {
    store.close();
  }
}
