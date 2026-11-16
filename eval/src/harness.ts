// The agent eval harness (brief §10): simulate a scenario, investigate it, score the result against
// the scenario's ground truth, and replay the recommended patch.
//
// Scores (all computed here, deterministically, from the record and the store):
//   rootCause        the diagnosis names a hypothesis kind the ground truth accepts, and its
//                    causal chain or its cause recommendation points at the culprit change
//   evidence         share of ledger FACTs that re-verify against the store (must be 100 %)
//   hallucinations   problems an independent deterministic re-verification of the PUBLISHED
//                    diagnosis finds: fabricated IDs, mismatched or ungrounded numbers, hypotheses
//                    used as premises (must be 0). Drafts the verifier sent back are counted apart.
//   redHerrings      no red herring is cited by the root cause, the causal chain or a cause fix
//   skeptic          the skeptic produced a valid challenge with new queries
//   patch            the recommended patch (the first `cause` recommendation, else the first one)
//                    resolves or improves the incident in replay
//
// Who played the model is part of every result: `scripted fixture` (a test double, not a model),
// `recorded` (a cassette of a real run) or `live`. A scripted result says nothing about a model.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CassetteLlm,
  DEFAULT_TOKEN_BUDGET,
  InvestigationError,
  Ledger,
  createLlmClient,
  investigate,
  llmConfigFromEnv,
  verifyDeterministic,
  verifyFacts,
  type Effort,
  type Investigation,
  type LlmClient,
} from '@tracepilot/agents';
import { ScriptedLlm, protocolScript } from '@tracepilot/agents/testing';
import { Replayer } from '@tracepilot/replay';
import { formatPatch, type FactEntry } from '@tracepilot/schema';
import { hashTelemetry, recordScenario, runSimulation, type Recording } from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { readGroundTruth, type GroundTruth } from './ground-truth.ts';
import { toDraft } from './scenario-a.ts';

/** Whether a recorded live run exists for this scenario and seed (the incident ID is derived from telemetry). */
export function hasRecordedRun(scenario: string, seed: number): boolean {
  const recording = recordScenario(scenario, seed);
  const store = new TelemetryStore(':memory:');
  try {
    const { incident } = store.ingest(
      runSimulation(recording.config, recording.workload).telemetry,
    );
    return liveCassette(incident.id) !== null;
  } finally {
    store.close();
  }
}

export const CASSETTE_DIR = fileURLToPath(new URL('../cassettes/', import.meta.url));

export type InvestigatorChoice = 'auto' | 'scripted' | 'cassette' | 'live';
export type InvestigatorSource = 'scripted fixture' | 'recorded' | 'live';

export interface EvalResult {
  scenario: string;
  seed: number;
  incidentId: string;
  investigator: { source: InvestigatorSource; model: string };
  /** Set when the investigation did not complete; the scores below are then failures. */
  error: string | null;
  outcome: Investigation['outcome'] | 'failed';
  rootCause: { expected: string[]; got: string | null; culpritCited: boolean; match: boolean };
  evidence: { facts: number; valid: number; rate: number };
  hallucinations: number;
  caughtInRevision: number;
  redHerrings: { notBlamed: boolean; blamed: string[] };
  skeptic: { challenged: boolean; newQueries: number };
  alternativesRejected: string[];
  patch: {
    recommended: string | null;
    addresses: string | null;
    verdict: string | null;
    improves: boolean;
  };
  pass: boolean;
}

const HALLUCINATION_CODES = new Set([
  'missing_evidence',
  'value_mismatch',
  'ungrounded_number',
  'hypothesis_as_premise',
]);

interface Prepared {
  recording: Recording;
  store: TelemetryStore;
  incidentId: string;
  telemetryHash: string;
}

function prepare(scenario: string, seed: number): Prepared {
  const recording = recordScenario(scenario, seed);
  const { telemetry } = runSimulation(recording.config, recording.workload);
  const store = new TelemetryStore(':memory:');
  const { incident } = store.ingest(telemetry, { source: 'synthetic' });
  return { recording, store, incidentId: incident.id, telemetryHash: hashTelemetry(telemetry) };
}

/** A cassette in eval/cassettes recorded from the live API, if one exists for this incident. */
function liveCassette(
  incidentId: string,
): { path: string; model: string; verifierModel: string; effort: Effort } | null {
  const path = `${CASSETTE_DIR}${incidentId}.json`;
  if (!existsSync(path)) return null;
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    upstream?: string;
    entries?: { request: { model: string; effort: string; tools: number } }[];
  };
  const first = file.entries?.[0]?.request;
  if (file.upstream !== 'live' || first === undefined) return null;
  const reviewer = file.entries?.find((e) => e.request.tools === 1)?.request;
  return {
    path,
    model: first.model,
    verifierModel: reviewer?.model ?? first.model,
    effort: first.effort as Effort,
  };
}

function chooseInvestigator(
  choice: InvestigatorChoice,
  incidentId: string,
  env: Readonly<Record<string, string | undefined>>,
): {
  llm: LlmClient;
  source: InvestigatorSource;
  model: string;
  verifierModel: string;
  effort: Effort;
} {
  const cassette = choice === 'auto' || choice === 'cassette' ? liveCassette(incidentId) : null;
  if (cassette !== null)
    return { llm: new CassetteLlm('replay', cassette.path), source: 'recorded', ...cassette };
  if (choice === 'cassette')
    throw new Error(`no recorded live cassette for ${incidentId} in ${CASSETTE_DIR}`);
  if (choice === 'live') {
    const config = { ...llmConfigFromEnv(env, '.'), mode: 'live' as const };
    return {
      llm: createLlmClient(config, incidentId),
      source: 'live',
      model: config.model,
      verifierModel: config.verifierModel,
      effort: config.effort,
    };
  }
  const none = 'none (scripted fixture)';
  return {
    llm: new ScriptedLlm(protocolScript()),
    source: 'scripted fixture',
    model: none,
    verifierModel: none,
    effort: 'medium',
  };
}

/** Facts cited by the root cause, the causal chain and the `cause` recommendations. */
function blamedFacts(inv: Investigation): FactEntry[] {
  const d = inv.diagnosis;
  if (d === null) return [];
  return Ledger.from(inv.ledger).factsBehind([
    ...d.rootCause.ledgerEntryIds,
    ...d.causalChain.flatMap((s) => s.ledgerEntryIds),
    ...d.recommendations.filter((r) => r.addresses === 'cause').flatMap((r) => r.ledgerEntryIds),
  ]);
}

function score(
  truth: GroundTruth,
  p: Prepared,
  inv: Investigation,
  replayer: Replayer,
): Omit<EvalResult, 'scenario' | 'seed' | 'incidentId' | 'investigator' | 'error' | 'pass'> {
  const d = inv.diagnosis;
  const facts = inv.ledger.filter((e): e is FactEntry => e.type === 'FACT');
  const badFacts = new Set(
    verifyFacts(p.store, p.incidentId, facts).flatMap((i) => i.ledgerEntryIds),
  );
  const valid = facts.filter((f) => !badFacts.has(f.id)).length;

  const hallucinations =
    d === null
      ? 0
      : verifyDeterministic({
          draft: toDraft(d),
          ledger: Ledger.from(inv.ledger),
          hypotheses: inv.hypotheses,
          store: p.store,
          incidentId: p.incidentId,
        }).filter((i) => HALLUCINATION_CODES.has(i.code)).length;
  const caughtInRevision = inv.verification
    .slice(0, -1)
    .flatMap((r) => r.deterministicIssues)
    .filter((i) => HALLUCINATION_CODES.has(i.code)).length;

  const culprit = truth.rootCause.changeEventId;
  const blamed = blamedFacts(inv);
  const culpritCited =
    blamed.some((f) => f.evidenceIds.includes(culprit)) ||
    (d?.recommendations.some(
      (r) => r.addresses === 'cause' && 'revert' in r.patch && r.patch.revert === culprit,
    ) ??
      false);
  const got = d?.rootCause.kind ?? null;

  const herringsBlamed: string[] = [];
  for (const h of truth.redHerrings) {
    const hit = blamed.filter((f) =>
      h.kind === 'change'
        ? h.changeEventId !== undefined && f.evidenceIds.includes(h.changeEventId)
        : h.fromUs !== undefined &&
          h.toUs !== undefined &&
          f.occurredAt !== undefined &&
          f.occurredAt.tsUs >= h.fromUs &&
          f.occurredAt.tsUs <= h.toUs + 60_000_000,
    );
    const reverted =
      d?.recommendations.some((r) => 'revert' in r.patch && r.patch.revert === h.changeEventId) ??
      false;
    if (hit.length > 0 || (h.kind === 'change' && reverted)) herringsBlamed.push(h.what);
  }

  const rec =
    d?.recommendations.find((r) => r.addresses === 'cause') ?? d?.recommendations[0] ?? null;
  let verdict: string | null = null;
  if (rec !== null) {
    const cmp = replayer.replayRecommendations([rec], 'eval');
    verdict = cmp.rows[0]?.verdict ?? null;
  }

  return {
    outcome: inv.outcome,
    rootCause: {
      expected: truth.rootCause.hypothesisKinds,
      got,
      culpritCited,
      match: got !== null && truth.rootCause.hypothesisKinds.includes(got) && culpritCited,
    },
    evidence: { facts: facts.length, valid, rate: facts.length === 0 ? 0 : valid / facts.length },
    hallucinations,
    caughtInRevision,
    redHerrings: { notBlamed: d !== null && herringsBlamed.length === 0, blamed: herringsBlamed },
    skeptic: {
      challenged: inv.skeptic !== null && inv.skeptic.newQueries.length > 0,
      newQueries: inv.skeptic?.newQueries.length ?? 0,
    },
    alternativesRejected: inv.hypotheses.filter((h) => h.status === 'rejected').map((h) => h.kind),
    patch: {
      recommended: rec === null ? null : formatPatch(rec.patch),
      addresses: rec?.addresses ?? null,
      verdict,
      improves: verdict === 'resolves' || verdict === 'improves',
    },
  };
}

export interface EvalOptions {
  scenario: string;
  seed?: number;
  investigator?: InvestigatorChoice;
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: a scripted client to play the model (reported as a scripted fixture). */
  scripted?: LlmClient;
}

export async function evaluateScenario(o: EvalOptions): Promise<EvalResult> {
  const seed = o.seed ?? 42;
  const truth = readGroundTruth(o.scenario);
  const p = prepare(o.scenario, seed);
  const who =
    o.scripted === undefined
      ? chooseInvestigator(o.investigator ?? 'auto', p.incidentId, o.env ?? process.env)
      : {
          llm: o.scripted,
          source: 'scripted fixture' as const,
          model: 'none (scripted fixture)',
          verifierModel: 'none (scripted fixture)',
          effort: 'medium' as const,
        };
  const base = {
    scenario: o.scenario,
    seed,
    incidentId: p.incidentId,
    investigator: { source: who.source, model: who.model },
  };
  try {
    const replayer = new Replayer({
      incidentId: p.incidentId,
      recording: p.recording,
      telemetryHash: p.telemetryHash,
    });
    let inv: Investigation;
    try {
      inv = await investigate({
        store: p.store,
        incidentId: p.incidentId,
        llm: who.llm,
        model: who.model,
        verifierModel: who.verifierModel,
        effort: who.effort,
        maxTokens: DEFAULT_TOKEN_BUDGET,
      });
    } catch (e) {
      // The investigation itself failed (a refused protocol, a budget, a script that cannot
      // follow this incident): every score is a failure, with the reason.
      if (!(e instanceof Error) || e instanceof TypeError || e instanceof RangeError) throw e;
      return {
        ...base,
        error: e instanceof InvestigationError ? e.message : `${e.name}: ${e.message}`,
        outcome: 'failed',
        rootCause: {
          expected: truth.rootCause.hypothesisKinds,
          got: null,
          culpritCited: false,
          match: false,
        },
        evidence: { facts: 0, valid: 0, rate: 0 },
        hallucinations: 0,
        caughtInRevision: 0,
        redHerrings: { notBlamed: false, blamed: [] },
        skeptic: { challenged: false, newQueries: 0 },
        alternativesRejected: [],
        patch: { recommended: null, addresses: null, verdict: null, improves: false },
        pass: false,
      };
    }
    const s = score(truth, p, inv, replayer);
    const pass =
      s.rootCause.match &&
      s.evidence.rate === 1 &&
      s.hallucinations === 0 &&
      s.redHerrings.notBlamed &&
      s.skeptic.challenged &&
      s.patch.improves;
    return { ...base, error: null, ...s, pass };
  } finally {
    p.store.close();
  }
}

// ---- the results table ------------------------------------------------------------------------

const yes = (b: boolean): string => (b ? 'yes' : '**no**');

/** A row for an evaluation that could not run, with the reason. */
export interface NotRun {
  scenario: string;
  seed: number;
  investigator: string;
  reason: string;
}

export function resultsTable(results: readonly (EvalResult | NotRun)[]): string {
  const rows = results.map((r) => {
    if ('reason' in r)
      return [
        `${r.scenario} (seed ${String(r.seed)})`,
        r.investigator,
        `not run: ${r.reason}`,
        '—',
        '—',
        '—',
        '—',
        '—',
        '—',
      ].join(' | ');
    const rc =
      r.error !== null
        ? `**failed**: ${r.error.split('\n')[0]?.slice(0, 80) ?? ''}`
        : `${r.rootCause.match ? 'match' : '**miss**'} (${r.rootCause.got ?? 'none'}${r.rootCause.culpritCited ? '' : ', culprit not cited'})`;
    return [
      `${r.scenario} (seed ${String(r.seed)})`,
      r.investigator.source,
      rc,
      r.error !== null
        ? '—'
        : `${(100 * r.evidence.rate).toFixed(0)}% of ${String(r.evidence.facts)}`,
      r.error !== null ? '—' : String(r.hallucinations),
      r.error !== null ? '—' : yes(r.redHerrings.notBlamed),
      r.error !== null ? '—' : yes(r.skeptic.challenged),
      r.patch.recommended === null
        ? '—'
        : `\`${r.patch.recommended}\` (${r.patch.addresses ?? ''}): ${r.patch.verdict ?? '—'}`,
      r.pass ? '**pass**' : '**fail**',
    ].join(' | ');
  });
  return [
    '| Scenario | Investigator | Root cause | Evidence valid | Hallucinations | Red herrings not blamed | Skeptic challenged | Recommended patch in replay | Overall |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r} |`),
  ].join('\n');
}
