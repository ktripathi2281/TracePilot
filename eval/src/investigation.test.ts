// The investigation engine on real scenario A telemetry, driven by a scripted TEST DOUBLE.
//
// What this file can show: the engine's rules hold whatever the "model" does. Tools produce the
// facts, the engine tests the hypotheses, the skeptic must do new work, the verifier sends bad
// drafts back, the budget is enforced, cassettes replay exactly.
// What it cannot show: that a real model follows the protocol and reaches the diagnosis. That is
// Gate 3 (gate3.test.ts), which needs a recorded live run.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BudgetExceededError,
  CassetteLlm,
  CassetteMissError,
  DATA_TOOL_NAMES,
  Investigation,
  InvestigationError,
  callKey,
  computeConfidence,
  investigate,
  loadPrompt,
  type InvestigationEvent,
  type LlmClient,
  type LlmRequest,
} from '@tracepilot/agents';
import {
  ScriptedLlm,
  protocolScript,
  seenFacts,
  seenResults,
  type Script,
  type ScriptedCall,
} from '@tracepilot/agents/testing';
import { Patch, type FactEntry, type Hypothesis } from '@tracepilot/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TEST_MODEL, factByKey, loadScenarioA, runScripted, type ScenarioA } from './scenario-a.ts';

const GroundTruth = z.object({
  rootCause: z.object({ changeEventId: z.string(), service: z.string(), resource: z.string() }),
  redHerrings: z.array(
    z.object({
      kind: z.enum(['change', 'disturbance']),
      changeEventId: z.string().optional(),
      service: z.string().optional(),
    }),
  ),
});
const truth = GroundTruth.parse(
  JSON.parse(
    readFileSync(new URL('../ground-truth/pool-exhaustion.json', import.meta.url), 'utf8'),
  ),
);
const herringChange = truth.redHerrings.find((h) => h.kind === 'change')?.changeEventId ?? '';
const herringService = truth.redHerrings.find((h) => h.kind === 'disturbance')?.service ?? '';

const isSkeptic = (r: LlmRequest): boolean => r.tools.some((t) => t.name === 'submit_challenge');
const isReviewer = (r: LlmRequest): boolean => r.tools.some((t) => t.name === 'submit_verdict');
const isInvestigator = (r: LlmRequest): boolean =>
  r.tools.some((t) => t.name === 'submit_diagnosis');

/** The protocol script with its tool calls rewritten by `change`. */
const withCalls =
  (
    change: (request: LlmRequest, calls: ScriptedCall[]) => ScriptedCall[],
    base: Script = protocolScript(),
  ): Script =>
  (request) => {
    const out = base(request);
    return typeof out === 'string' ? out : change(request, out);
  };

interface RawProposal {
  hypotheses: {
    kind: string;
    title: string;
    predictions: { findingKey: string; expected: unknown; tool: string; args: unknown }[];
  }[];
}
interface RawDiagnosis {
  rootCause: { statement: string; ledgerEntryIds: string[]; hypothesisId: string };
  causalChain: { statement: string; ledgerEntryIds: string[]; onsetEntryId: string }[];
}

let a: ScenarioA;
let inv: Investigation;
let llm: ScriptedLlm;
const events: InvestigationEvent[] = [];
const tmp = mkdtempSync(join(tmpdir(), 'tracepilot-investigation-'));

beforeAll(async () => {
  a = loadScenarioA();
  const run = await runScripted(a, protocolScript(), { onEvent: (e) => events.push(e) });
  inv = run.investigation;
  llm = run.llm;
}, 120_000);
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const hyp = (kind: string): Hypothesis => {
  const h = inv.hypotheses.find((x) => x.kind === kind);
  if (h === undefined) throw new Error(`no hypothesis of kind ${kind}`);
  return h;
};
const rejections = (list: InvestigationEvent[]): string =>
  list.flatMap((e) => (e.type === 'rejected_input' ? e.problems : [])).join('\n');

describe('facts come from tools, never from the model', () => {
  it('every FACT was produced by a data tool and cites telemetry in the store', () => {
    const facts = inv.ledger.filter((e): e is FactEntry => e.type === 'FACT');
    expect(facts.length).toBeGreaterThan(50);
    for (const f of facts) {
      expect(DATA_TOOL_NAMES, f.id).toContain(f.tool);
      expect(f.evidenceIds.length, f.id).toBeGreaterThan(0);
    }
  });

  it('the model is never offered a tool that writes a FACT', () => {
    const offered = new Set(llm.requests.flatMap((r) => r.tools.map((t) => t.name)));
    expect([...offered].filter((n) => !DATA_TOOL_NAMES.includes(n)).sort()).toEqual([
      'propose_hypotheses',
      'record_inference',
      'submit_challenge',
      'submit_diagnosis',
      'submit_verdict',
    ]);
  });

  it('records which model answered, and warns when it is not the one requested', async () => {
    expect(inv.llm.answeredBy).toEqual([TEST_MODEL]);
    expect(inv.warnings.join('\n')).not.toMatch(/fallback/);
    const scripted = new ScriptedLlm(protocolScript());
    // A client whose answers come from another model, as after a server-side fallback.
    const fallback: LlmClient = {
      mode: 'live',
      complete: async (r) => ({ ...(await scripted.complete(r)), model: 'other-model' }),
    };
    const run = await investigate({
      store: a.store,
      incidentId: a.incidentId,
      llm: fallback,
      model: TEST_MODEL,
      maxTokens: 1e6,
    });
    expect(run.llm.answeredBy).toEqual(['other-model']);
    expect(run.warnings).toContain(
      `A investigator request for ${TEST_MODEL} was answered by other-model (server-side fallback).`,
    );
  });

  it('the record parses against the schema and is deterministic', async () => {
    expect(Investigation.safeParse(inv).success).toBe(true);
    expect(inv).toMatchObject({
      outcome: 'diagnosed',
      llm: { mode: 'scripted', recorded: false, model: TEST_MODEL },
    });
    const again = await runScripted(a);
    expect(again.investigation).toEqual(inv);
  });
});

describe('hypothesis engine', () => {
  it('tests "pool too small", "hold-and-wait starvation" and "DB slow" against each other', () => {
    expect(inv.hypotheses.map((h) => h.kind).sort()).toEqual([
      'db_slow',
      'hold_and_wait',
      'pool_capacity',
    ]);
    expect(hyp('hold_and_wait').status).toBe('supported');
    expect(hyp('pool_capacity').status).toBe('rejected');
    expect(hyp('db_slow').status).toBe('rejected');
    expect(inv.leadingHypothesisId).toBe(hyp('hold_and_wait').id);
  });

  it('every pair is discriminated by a prediction on the same finding with different outcomes', () => {
    const kinds = ['hold_and_wait', 'pool_capacity', 'db_slow'];
    for (let i = 0; i < kinds.length; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        const [x, y] = [hyp(kinds[i] as string), hyp(kinds[j] as string)];
        const shared = x.predictions.flatMap((p) =>
          y.predictions
            .filter(
              (q) =>
                callKey(p.check.tool, p.check.args) === callKey(q.check.tool, q.check.args) &&
                p.check.findingKey === q.check.findingKey &&
                p.check.expected !== q.check.expected,
            )
            .map((q) => [p, q] as const),
        );
        expect(shared.length, `${x.kind} vs ${y.kind}`).toBeGreaterThan(0);
        // The same observation supports one and contradicts the other.
        for (const [p, q] of shared) {
          expect(p.observed).toEqual(q.observed);
          expect(p.ledgerEntryIds).toEqual(q.ledgerEntryIds);
          expect(new Set([p.result, q.result])).toEqual(new Set(['supported', 'contradicted']));
        }
      }
    }
  });

  it('the engine, not the model, decides each prediction from the tool finding', () => {
    for (const h of inv.hypotheses) {
      for (const p of h.predictions) {
        const fact = inv.ledger.find((e) => e.id === p.ledgerEntryIds[0]);
        if (fact?.type !== 'FACT') throw new Error(`${p.id} has no fact`);
        expect(fact.findingKey).toBe(p.check.findingKey);
        expect(p.observed).toEqual(fact.value);
        expect(p.result).toBe(fact.value === p.check.expected ? 'supported' : 'contradicted');
      }
    }
    // "Pool too small" fails because the connections are idle, not busy; "DB slow" because
    // query execution time did not change.
    const contradicted = (h: Hypothesis): string[] =>
      h.predictions.filter((p) => p.result === 'contradicted').map((p) => p.check.findingKey);
    expect(contradicted(hyp('pool_capacity'))).toEqual(['hold_and_wait.incident.idle_held']);
    expect(contradicted(hyp('db_slow'))).toContain('db_exec.incident.flat');
  });

  it('sends a proposal back when a required explanation is missing', async () => {
    let first = true;
    const seen: InvestigationEvent[] = [];
    const script = withCalls((_, calls) => {
      const p = calls.find((c) => c.name === 'propose_hypotheses');
      if (p === undefined || !first) return calls;
      first = false;
      const input = structuredClone(p.input) as RawProposal;
      const db = input.hypotheses.find((h) => h.kind === 'db_slow');
      if (db !== undefined) db.kind = 'other';
      return [{ name: 'propose_hypotheses', input }];
    });
    const run = await runScripted(a, script, { onEvent: (e) => seen.push(e) });
    expect(rejections(seen)).toMatch(
      /missing required hypothesis kind\(s\) db_slow: db\.pool is saturated/,
    );
    expect(run.investigation.outcome).toBe('diagnosed');
    expect(run.investigation.hypotheses.map((h) => h.kind)).toContain('db_slow');
  });

  it('sends a proposal back when two required explanations predict the same things', async () => {
    let first = true;
    const seen: InvestigationEvent[] = [];
    const script = withCalls((_, calls) => {
      const p = calls.find((c) => c.name === 'propose_hypotheses');
      if (p === undefined || !first) return calls;
      first = false;
      const input = structuredClone(p.input) as RawProposal;
      const pool = input.hypotheses.find((h) => h.kind === 'pool_capacity');
      const hw = input.hypotheses.find((h) => h.kind === 'hold_and_wait');
      if (pool !== undefined && hw !== undefined) pool.predictions = hw.predictions;
      return [{ name: 'propose_hypotheses', input }];
    });
    const run = await runScripted(a, script, { onEvent: (e) => seen.push(e) });
    const said = rejections(seen);
    expect(said).toMatch(
      /"Connection hold-and-wait starvation" and "Pool too small for demand" are not discriminated/,
    );
    expect(said).toMatch(
      /is of kind pool_capacity and must include the prediction that defines that kind/,
    );
    expect(run.investigation.outcome).toBe('diagnosed');
  });

  it('gives up with a clear error if no valid set of hypotheses is ever proposed', async () => {
    const script = withCalls((_, calls) =>
      calls.map((c) => {
        if (c.name !== 'propose_hypotheses') return c;
        const input = structuredClone(c.input) as RawProposal;
        input.hypotheses = input.hypotheses.filter((h) => h.kind !== 'db_slow');
        return { name: c.name, input };
      }),
    );
    await expect(runScripted(a, script)).rejects.toThrow(InvestigationError);
  });
});

describe('skeptic', () => {
  it('works in its own context with its own prompt', () => {
    const skepticRequests = llm.requests.filter(isSkeptic);
    expect(skepticRequests.length).toBeGreaterThan(0);
    for (const r of skepticRequests) {
      expect(r.system).toBe(loadPrompt('skeptic'));
      expect(r.system).not.toBe(loadPrompt('investigator'));
      // Its conversation starts from a brief, not from the investigator's transcript.
      const brief = JSON.parse(String(r.messages[0]?.content)) as Record<string, unknown>;
      expect(Object.keys(brief).sort()).toEqual([
        'incident',
        'leadingHypothesis',
        'otherHypotheses',
        'queriesAlreadyRun',
        'required',
      ]);
    }
  });

  it('runs at least three queries nobody ran before, against the leading hypothesis and the strongest alternative', () => {
    const s = inv.skeptic;
    if (s === null) throw new Error('no skeptic report');
    expect(s.newQueries.length).toBeGreaterThanOrEqual(3);
    // "New" means new: none was run by the investigator or by the hypothesis tests before it.
    const brief = JSON.parse(String(llm.requests.find(isSkeptic)?.messages[0]?.content)) as {
      queriesAlreadyRun: string[];
    };
    expect(brief.queriesAlreadyRun.length).toBeGreaterThan(5);
    for (const q of s.newQueries) expect(brief.queriesAlreadyRun).not.toContain(q);

    const bySkeptic = new Set(
      inv.ledger.filter((e) => e.type === 'FACT' && e.author === 'skeptic').map((e) => e.id),
    );
    expect(bySkeptic.size).toBeGreaterThan(0);
    const citesNew = (ids: string[]): boolean => ids.some((id) => bySkeptic.has(id));
    expect(s.leadingHypothesisId).toBe(hyp('hold_and_wait').id);
    expect(s.againstLeading.some((c) => citesNew(c.ledgerEntryIds))).toBe(true);
    expect(s.alternativeHypothesisId).toBe(hyp('pool_capacity').id);
    expect(s.alternativeChecks.some((c) => citesNew(c.ledgerEntryIds))).toBe(true);
  });

  it('is sent back if it ran too few new queries', async () => {
    const seen: InvestigationEvent[] = [];
    const script = withCalls((request, calls) => {
      if (!isSkeptic(request)) return calls;
      const results = seenResults(request);
      if (results.length === 0) {
        // Two new queries and one the investigator already ran.
        return [
          { name: 'analyze_hold_and_wait', input: { window: 'baseline' } },
          {
            name: 'get_metric_series',
            input: { service: 'db', metric: 'db_active_queries', window: 'incident' },
          },
          { name: 'analyze_propagation', input: {} },
        ];
      }
      const last = results.at(-1);
      if (last?.tool === 'submit_challenge' && last.isError)
        return [{ name: 'attribute_latency', input: { window: 'baseline' } }];
      return calls;
    });
    const run = await runScripted(a, script, { onEvent: (e) => seen.push(e) });
    expect(rejections(seen)).toMatch(/you ran 2 new tool queries; at least 3 are required/);
    expect(run.investigation.skeptic?.newQueries).toHaveLength(3);
  });

  it('is sent back if its challenge rests only on facts the investigator already had', async () => {
    const seen: InvestigationEvent[] = [];
    let first = true;
    const script = withCalls((request, calls) => {
      const c = calls.find((x) => x.name === 'submit_challenge');
      if (c === undefined || !first) return calls;
      first = false;
      const old = seenFacts(request).get('propagation.origin')?.id ?? '';
      const input = structuredClone(c.input) as {
        againstLeading: { ledgerEntryIds: string[] }[];
        strongestAlternative: { checks: { ledgerEntryIds: string[] }[] };
      };
      for (const x of input.againstLeading) x.ledgerEntryIds = [old];
      for (const x of input.strongestAlternative.checks) x.ledgerEntryIds = [old];
      return [{ name: 'submit_challenge', input }];
    });
    const run = await runScripted(a, script, { onEvent: (e) => seen.push(e) });
    const said = rejections(seen);
    expect(said).toMatch(
      /againstLeading: at least one challenge must cite a fact from one of your new queries/,
    );
    expect(said).toMatch(
      /strongestAlternative\.checks: at least one check must cite a fact from one of your new queries/,
    );
    expect(run.investigation.skeptic).not.toBeNull();
  });

  it('is recorded as absent, and costs confidence, if it never produces a valid challenge', async () => {
    const script = withCalls((request, calls) =>
      isSkeptic(request) && seenResults(request).length === 0
        ? [{ name: 'analyze_hold_and_wait', input: { window: 'baseline' } }]
        : calls,
    );
    const run = await runScripted(a, script);
    expect(run.investigation.skeptic).toBeNull();
    expect(run.investigation.warnings.join('\n')).toMatch(
      /The skeptic did not produce a valid challenge/,
    );
    expect(run.investigation.outcome).toBe('diagnosed');
    expect(run.investigation.confidence?.score).toBeCloseTo((inv.confidence?.score ?? 0) - 0.1, 10);
  });
});

describe('diagnosis', () => {
  it('names the structural root cause: a connection held across downstream calls', () => {
    const d = inv.diagnosis;
    if (d === null) throw new Error('no diagnosis');
    // The kind is copied by the engine from the hypothesis that survived its tests.
    expect(d.rootCause).toMatchObject({
      kind: 'hold_and_wait',
      hypothesisId: hyp('hold_and_wait').id,
    });
    const nested = factByKey(inv, 'hold_and_wait.incident.nested_wait');
    const holder = factByKey(inv, 'hold_and_wait.incident.holder');
    expect(d.rootCause.ledgerEntryIds).toEqual(expect.arrayContaining([nested.id, holder.id]));
    expect(nested.value).toBe(true);
    expect(nested.statement).toMatch(/downstream calls waited in db\.pool\.acquire/);
    expect(holder.value).toBe(truth.rootCause.service);
    // Not "the pool is too small": that hypothesis was tested and rejected.
    expect(d.rootCause.kind).not.toBe('pool_capacity');
    expect(d.rejectedHypotheses.map((r) => r.hypothesisId)).toContain(hyp('pool_capacity').id);
  });

  it('rejects "DB slow" and "pool too small" with the facts that contradicted them', () => {
    const d = inv.diagnosis;
    if (d === null) throw new Error('no diagnosis');
    for (const kind of ['db_slow', 'pool_capacity']) {
      const h = hyp(kind);
      const r = d.rejectedHypotheses.find((x) => x.hypothesisId === h.id);
      expect(r, kind).toBeDefined();
      const contradicting = h.predictions
        .filter((p) => p.result === 'contradicted')
        .flatMap((p) => p.ledgerEntryIds);
      expect(
        r?.ledgerEntryIds.some((id) => contradicting.includes(id)),
        kind,
      ).toBe(true);
    }
    expect(factByKey(inv, 'db_exec.incident.flat').value).toBe(true);
  });

  it('carries machine-readable patches for replay, and says which treat the cause', () => {
    const d = inv.diagnosis;
    if (d === null) throw new Error('no diagnosis');
    for (const r of d.recommendations) expect(Patch.safeParse(r.patch).success, r.id).toBe(true);
    expect(d.recommendations.map((r) => r.id)).toEqual(['rc_1', 'rc_2']);
    const cause = d.recommendations.find((r) => r.addresses === 'cause');
    expect(cause?.patch).toEqual({ revert: truth.rootCause.changeEventId });
    const pool = d.recommendations.find(
      (r) => 'target' in r.patch && r.patch.target === 'db.pool.capacity',
    );
    // A larger pool is offered as a patch to try, but labelled as treating the symptom.
    expect(pool?.addresses).toBe('symptom');
    // The structural fix is a code change: it cannot be simulated, so it is a follow-up.
    expect(d.followUps.length).toBeGreaterThan(0);
    expect(d.followUps[0]?.ledgerEntryIds).toContain(
      factByKey(inv, 'hold_and_wait.incident.nested_wait').id,
    );
  });

  it('does not blame the red herrings', () => {
    const d = inv.diagnosis;
    if (d === null) throw new Error('no diagnosis');
    expect(factByKey(inv, `change_correlation.${herringChange}.verdict`).value).toBe('none');
    expect(
      factByKey(inv, `change_correlation.${truth.rootCause.changeEventId}.verdict`).value,
    ).toBe('correlated');
    const herringFacts = new Set(
      inv.ledger
        .filter(
          (e) =>
            e.type === 'FACT' &&
            (e.evidenceIds.includes(herringChange) ||
              e.findingKey.startsWith(`propagation.excluded.${herringService}.`)),
        )
        .map((e) => e.id),
    );
    expect(herringFacts.size).toBeGreaterThan(0);
    const blamed = [
      ...d.rootCause.ledgerEntryIds,
      ...d.causalChain.flatMap((s) => s.ledgerEntryIds),
      ...d.recommendations.flatMap((r) => r.ledgerEntryIds),
    ];
    expect(blamed.filter((id) => herringFacts.has(id))).toEqual([]);
    expect(d.recommendations.map((r) => r.patch)).not.toContainEqual({ revert: herringChange });
    expect(factByKey(inv, 'propagation.origin').value).toBe('db');
    expect(d.causalChain.map((s) => s.service)).not.toContain(herringService);
  });

  it('gets its confidence from the rubric, not from the model', () => {
    const d = inv.diagnosis;
    if (d === null) throw new Error('no diagnosis');
    expect(d.confidence).toEqual(
      computeConfidence(hyp('hold_and_wait'), inv.hypotheses, inv.skeptic, []),
    );
    expect(inv.confidence).toEqual(d.confidence);
    const diagnosisRequests = llm.requests.filter(isInvestigator);
    expect(JSON.stringify(diagnosisRequests[0]?.tools)).not.toMatch(/"confidence"/);
  });
});

describe('verifier loop', () => {
  it('accepts a clean diagnosis in one round, deterministic pass first, then the logic pass', () => {
    expect(inv.verification).toEqual([
      { round: 0, deterministicIssues: [], llmPass: 'ran', llmIssues: [] },
    ]);
    expect(inv.revisionRounds).toBe(0);
    const reviewer = llm.requests.filter(isReviewer);
    expect(reviewer).toHaveLength(1);
    expect(reviewer[0]?.system).toBe(loadPrompt('verifier'));
    expect(reviewer[0]?.tools.map((t) => t.name)).toEqual(['submit_verdict']);
  });

  it('sends back a draft with a number that is in no cited fact, and publishes the revision', async () => {
    const seen: InvestigationEvent[] = [];
    const run = await runScripted(a, protocolScript({ firstDraftUngrounded: true }), {
      onEvent: (e) => seen.push(e),
    });
    const v = run.investigation.verification;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ round: 0, llmPass: 'not_reached', llmIssues: [] });
    expect(v[0]?.deterministicIssues).toEqual([
      expect.objectContaining({ code: 'ungrounded_number', location: 'rootCause' }),
    ]);
    expect(v[1]).toEqual({ round: 1, deterministicIssues: [], llmPass: 'ran', llmIssues: [] });
    expect(run.investigation).toMatchObject({ outcome: 'diagnosed', revisionRounds: 1 });
    expect(run.investigation.diagnosis?.unresolvedIssues).toEqual([]);
    expect(run.investigation.diagnosis?.rootCause.statement).not.toMatch(/98765/);
    // The logic pass is not spent on a draft the deterministic pass already rejected.
    expect(run.llm.requests.filter(isReviewer)).toHaveLength(1);
    // The model is told exactly what to fix.
    const told = seenResults(run.llm.requests.at(-2) as LlmRequest).at(-1);
    expect(told).toMatchObject({ tool: 'submit_diagnosis', isError: true });
    expect(told?.text).toMatch(
      /verification failed \(revision round 1 of 2\)[\s\S]*\[ungrounded_number\] rootCause/,
    );
  });

  it('feeds the logic pass into a revision round too', async () => {
    const run = await runScripted(a, protocolScript({ reviewerRejectsOnce: true }));
    const v = run.investigation.verification;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ deterministicIssues: [], llmPass: 'ran' });
    expect(v[0]?.llmIssues).toEqual([
      expect.objectContaining({ code: 'unsupported_logic', location: 'rootCause' }),
    ]);
    expect(v[1]).toMatchObject({ deterministicIssues: [], llmIssues: [] });
    expect(run.investigation.revisionRounds).toBe(1);
  });

  it('after two failed revisions publishes with the open issues listed and lower confidence', async () => {
    const script = withCalls((_, calls) =>
      calls.map((c) => {
        if (c.name !== 'submit_diagnosis') return c;
        const input = structuredClone(c.input) as RawDiagnosis;
        input.rootCause.statement += ' It lasted 98765 ms.';
        return { name: c.name, input };
      }),
    );
    const run = await runScripted(a, script);
    const i = run.investigation;
    expect(i.verification).toHaveLength(3);
    expect(i.revisionRounds).toBe(2);
    expect(i.outcome).toBe('diagnosed');
    expect(i.diagnosis?.unresolvedIssues).toEqual([
      expect.objectContaining({ code: 'ungrounded_number', location: 'rootCause' }),
    ]);
    const clean = inv.diagnosis?.confidence.score ?? 0;
    expect(i.diagnosis?.confidence.score).toBeCloseTo(clean - 0.15, 10);
  });

  it('rejects fabricated IDs, a hypothesis cited as evidence and a reversed chain, in one round', async () => {
    let first = true;
    const script = withCalls((request, calls) =>
      calls.map((c) => {
        if (c.name !== 'submit_diagnosis' || !first) return c;
        first = false;
        const input = structuredClone(c.input) as RawDiagnosis;
        const board = seenResults(request).find((r) => r.tool === 'propose_hypotheses')?.data as {
          tested: { id: string }[];
        };
        expect(board.tested.length).toBe(3);
        input.rootCause.ledgerEntryIds.push('le_made_up');
        input.causalChain.reverse();
        return { name: c.name, input };
      }),
    );
    const run = await runScripted(a, script);
    const first0 = run.investigation.verification[0]?.deterministicIssues ?? [];
    expect([...new Set(first0.map((x) => x.code))].sort()).toEqual([
      'missing_evidence',
      'temporal_precedence',
    ]);
    expect(run.investigation.verification.at(-1)?.deterministicIssues).toEqual([]);
    expect(run.investigation.diagnosis?.unresolvedIssues).toEqual([]);
  });

  it('refuses an inference that rests on a hypothesis or carries an ungrounded number', async () => {
    let done = false;
    const script = withCalls((request, calls) => {
      if (!isInvestigator(request) || done) return calls;
      if (!calls.some((c) => c.name === 'submit_diagnosis')) return calls;
      done = true;
      const facts = seenFacts(request);
      const pool = facts.get('saturation.db.pool.incident.status')?.id ?? '';
      return [
        // Hypothesis entries are in the ledger right after the last fact of the first round.
        {
          name: 'record_inference',
          input: { statement: 'The database is slow.', rule: 'assumed', premises: [HYP_ENTRY()] },
        },
        {
          name: 'record_inference',
          input: { statement: 'The pool has 77 connections.', rule: 'read', premises: [pool] },
        },
        {
          name: 'record_inference',
          input: { statement: 'The pool was saturated.', rule: 'read', premises: [pool] },
        },
      ];
    });
    const HYP_ENTRY = (): string => inv.hypotheses[2]?.ledgerEntryId ?? '';
    const run = await runScripted(a, script);
    const results = run.llm.requests
      .flatMap((r) => seenResults(r))
      .filter((r) => r.tool === 'record_inference');
    const texts = [...new Set(results.map((r) => `${r.isError ? 'ERR' : 'OK'} ${r.text}`))];
    expect(texts).toHaveLength(3);
    expect(texts[0]).toMatch(/^ERR not recorded: .*HYPOTHESIS cannot be a premise/);
    expect(texts[1]).toMatch(/^ERR not recorded: number\(s\) 77 do not appear/);
    expect(texts[2]).toMatch(/^OK .*"type":"INFERENCE"/);
    expect(run.investigation.ledger.filter((e) => e.type === 'INFERENCE')).toHaveLength(1);
    expect(run.investigation.outcome).toBe('diagnosed');
  });
});

describe('tool loop', () => {
  it('returns bad tool calls to the model as errors instead of crashing', async () => {
    let first = true;
    const script = withCalls((request, calls) => {
      if (!isInvestigator(request) || !first) return calls;
      first = false;
      return [
        ...calls,
        { name: 'get_saturation', input: { window: 'last tuesday' } },
        { name: 'drop_database', input: {} },
        { name: 'get_trace', input: { traceId: 'tr_does_not_exist' } },
      ];
    });
    const run = await runScripted(a, script);
    const errors = seenResults(run.llm.requests[1] as LlmRequest).filter((r) => r.isError);
    expect(errors.map((e) => e.tool)).toEqual(['get_saturation', 'drop_database', 'get_trace']);
    expect(errors[1]?.text).toMatch(/unknown tool/);
    expect(run.investigation.outcome).toBe('diagnosed');
  });

  it('nudges a model that stops calling tools, then ends inconclusive rather than inventing a diagnosis', async () => {
    const run = await runScripted(a, () => 'I think the database is probably slow.');
    expect(run.llm.requests).toHaveLength(4);
    expect(String(run.llm.requests[1]?.messages.at(-1)?.content)).toMatch(
      /Nothing is finished until you call a tool/,
    );
    expect(run.investigation).toMatchObject({
      outcome: 'inconclusive',
      diagnosis: null,
      confidence: null,
      hypotheses: [],
    });
    expect(run.investigation.warnings).toContain(
      'The investigator stopped before a diagnosis was verified.',
    );
  });

  it('reports progress as events', () => {
    const stages = events.flatMap((e) => (e.type === 'stage' ? [e.stage] : []));
    expect(stages).toEqual([
      'investigating',
      'testing_hypotheses',
      'skeptic',
      'investigating',
      'verifying',
      'done',
    ]);
    const types = new Set(events.map((e) => e.type));
    expect([...types].sort()).toEqual([
      'hypotheses',
      'skeptic',
      'stage',
      'tool',
      'usage',
      'verification',
    ]);
  });
});

describe('token budget', () => {
  it('stops the investigation before the next call once the budget is spent', async () => {
    const scripted = new ScriptedLlm(protocolScript()); // 1200 tokens per call
    await expect(
      investigate({
        store: a.store,
        incidentId: a.incidentId,
        llm: scripted,
        model: TEST_MODEL,
        maxTokens: 3000,
      }),
    ).rejects.toThrow(BudgetExceededError);
    expect(scripted.requests).toHaveLength(3);
  });

  it('counts every role against the same budget and reports usage per role', () => {
    expect(inv.usage).toMatchObject({
      calls: llm.requests.length,
      totalTokens: llm.requests.length * 1200,
      budgetTokens: 1_000_000,
      estimatedCostUsd: null,
    });
    expect(Object.keys(inv.usage.byRole).sort()).toEqual(['investigator', 'skeptic', 'verifier']);
  });
});

describe('cassettes over a whole investigation', () => {
  // The upstream here is the scripted double made to look live, so the record and replay paths
  // run without the network. The files are test artifacts in a temp directory, deleted afterwards.
  const pretendLive = (): { client: LlmClient; calls: () => number } => {
    const scripted = new ScriptedLlm(protocolScript());
    return {
      client: { mode: 'live', complete: (r) => scripted.complete(r) },
      calls: () => scripted.requests.length,
    };
  };
  const run = (client: LlmClient, model = TEST_MODEL): Promise<Investigation> =>
    investigate({ store: a.store, incidentId: a.incidentId, llm: client, model, maxTokens: 1e6 });

  it('record then replay gives the same investigation, marked as a recorded run', async () => {
    const path = join(tmp, 'roundtrip.json');
    const up = pretendLive();
    const recorder = new CassetteLlm('record', path, up.client);
    const recorded = await run(recorder);
    expect(recorded.llm).toMatchObject({ mode: 'record', recorded: false });
    expect(recorder.recorded).toBe(up.calls());
    const file = JSON.parse(readFileSync(path, 'utf8')) as { entries: { answeredBy: string }[] };
    expect(new Set(file.entries.map((e) => e.answeredBy))).toEqual(new Set([TEST_MODEL]));

    const replayer = new CassetteLlm('replay', path);
    const replayed = await run(replayer);
    expect(replayer.replayed).toBe(recorder.recorded);
    expect(replayed.llm).toMatchObject({ mode: 'replay', recorded: true });
    expect({ ...replayed, llm: null }).toEqual({ ...recorded, llm: null });

    // Recording again costs nothing: every request is already on the cassette.
    const up2 = pretendLive();
    await run(new CassetteLlm('record', path, up2.client));
    expect(up2.calls()).toBe(0);
  });

  it('replay fails loudly when anything the model would see has changed', async () => {
    const path = join(tmp, 'strict.json');
    await run(new CassetteLlm('record', path, pretendLive().client));
    await expect(run(new CassetteLlm('replay', path), 'another-model')).rejects.toThrow(
      CassetteMissError,
    );
    // Different telemetry (another seed) means different tool results, hence different requests.
    const other = loadScenarioA(7);
    await expect(
      investigate({
        store: other.store,
        incidentId: other.incidentId,
        llm: new CassetteLlm('replay', path),
        model: TEST_MODEL,
        maxTokens: 1e6,
      }),
    ).rejects.toThrow(CassetteMissError);
  });

  it('a cassette recorded from the test double is never presented as a recorded run', async () => {
    const path = join(tmp, 'double.json');
    await run(new CassetteLlm('record', path, new ScriptedLlm(protocolScript())));
    const replayed = await run(new CassetteLlm('replay', path));
    expect(replayed.llm).toMatchObject({ mode: 'scripted', recorded: false });
  });
});
