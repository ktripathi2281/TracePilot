// The verifier's deterministic pass on real scenario A telemetry (brief §0 rule 2, §8).
//
// It must reject, each with its own test below:
//   1. fabricated IDs                         -> missing_evidence
//   2. mismatched numbers                     -> value_mismatch / ungrounded_number
//   3. a HYPOTHESIS used as a FACT premise    -> hypothesis_as_premise
//   4. effect-before-cause chains             -> temporal_precedence
//
// Setup: one investigation of scenario A driven by a scripted test double gives a ledger of real
// facts and a diagnosis the verifier accepts. Each test then corrupts ONE thing and checks that
// the verifier names it. No model is involved anywhere in this file.

import {
  Ledger,
  verifyDeterministic,
  verifyFacts,
  type DiagnosisDraft,
  type Investigation,
} from '@tracepilot/agents';
import type { FactEntry, LedgerEntry, VerifierIssue } from '@tracepilot/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  factByKey,
  ledgerWith,
  loadScenarioA,
  runScripted,
  toDraft,
  type ScenarioA,
} from './scenario-a.ts';

let a: ScenarioA;
let inv: Investigation;
let clean: DiagnosisDraft;

beforeAll(async () => {
  a = loadScenarioA();
  inv = (await runScripted(a)).investigation;
  if (inv.diagnosis === null) throw new Error('fixture: the scripted run produced no diagnosis');
  clean = toDraft(inv.diagnosis);
}, 120_000);

const verify = (draft: DiagnosisDraft, ledger: Ledger = Ledger.from(inv.ledger)): VerifierIssue[] =>
  verifyDeterministic({
    draft,
    ledger,
    hypotheses: inv.hypotheses,
    store: a.store,
    incidentId: a.incidentId,
  });
const edit = (change: (d: DiagnosisDraft) => void): DiagnosisDraft => {
  const d = structuredClone(clean);
  change(d);
  return d;
};
const codes = (issues: VerifierIssue[]): string[] => [...new Set(issues.map((i) => i.code))];
const facts = (): FactEntry[] => inv.ledger.filter((e): e is FactEntry => e.type === 'FACT');

describe('an honest diagnosis', () => {
  it('passes with no issues, and every fact in the ledger is reproduced from the store', () => {
    expect(facts().length).toBeGreaterThan(50);
    expect(verifyFacts(a.store, a.incidentId, facts())).toEqual([]);
    expect(verify(clean)).toEqual([]);
  });

  it('rests on evidence that exists: every fact cites stored telemetry items', () => {
    for (const f of facts()) {
      expect(f.evidenceIds.length, f.id).toBeGreaterThan(0);
      for (const id of f.evidenceIds)
        expect(a.store.getEvidence(a.incidentId, id), `${f.id} -> ${id}`).toBeDefined();
    }
  });
});

describe('1. fabricated IDs are rejected', () => {
  it('a claim citing a ledger entry that does not exist', () => {
    const issues = verify(edit((d) => d.rootCause.ledgerEntryIds.push('le_zzzz')));
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'missing_evidence',
        location: 'rootCause',
        message: expect.stringContaining('le_zzzz') as string,
      }),
    );
  });

  it('a made-up ledger ID anywhere in the diagnosis', () => {
    const spots: [string, (d: DiagnosisDraft) => void][] = [
      ['causalChain[1]', (d) => d.causalChain[1]?.ledgerEntryIds.push('le_fake')],
      ['rejectedHypotheses[0]', (d) => d.rejectedHypotheses[0]?.ledgerEntryIds.push('le_fake')],
      ['recommendations[0]', (d) => d.recommendations[0]?.ledgerEntryIds.push('le_fake')],
      ['followUps[0]', (d) => d.followUps[0]?.ledgerEntryIds.push('le_fake')],
    ];
    for (const [location, change] of spots) {
      expect(verify(edit(change)), location).toContainEqual(
        expect.objectContaining({ code: 'missing_evidence', location }),
      );
    }
  });

  it('a FACT citing a span, metric point or change event that is not in the store', () => {
    const target = factByKey(inv, 'hold_and_wait.incident.nested_wait');
    for (const fake of ['sp_0123456789abcdef', 'mt_db_pool_in_use_1', 'ev_99']) {
      const ledger = ledgerWith(inv, target.id, (f) => ({
        ...f,
        evidenceIds: [...f.evidenceIds, fake],
      }));
      expect(verify(clean, ledger), fake).toContainEqual(
        expect.objectContaining({
          code: 'missing_evidence',
          location: `ledger:${target.id}`,
          message: expect.stringContaining(fake) as string,
        }),
      );
    }
  });

  it('a FACT citing a real telemetry item that its finding does not rest on', () => {
    const target = factByKey(inv, 'hold_and_wait.incident.holder');
    const unrelated = factByKey(inv, 'change.ev_1').evidenceIds[0] ?? '';
    const ledger = ledgerWith(inv, target.id, (f) => ({
      ...f,
      evidenceIds: [...f.evidenceIds, unrelated],
    }));
    expect(verify(clean, ledger)).toContainEqual(
      expect.objectContaining({
        code: 'value_mismatch',
        location: `ledger:${target.id}`,
        message: expect.stringContaining('which the finding does not rest on') as string,
      }),
    );
  });

  it('a FACT from a tool call that was never possible', () => {
    const target = factByKey(inv, 'db_exec.incident.flat');
    const madeUpKey = ledgerWith(inv, target.id, (f) => ({
      ...f,
      findingKey: 'db_exec.incident.much_slower',
    }));
    expect(verify(clean, madeUpKey)).toContainEqual(
      expect.objectContaining({ code: 'value_mismatch', location: `ledger:${target.id}` }),
    );
    const madeUpTool = ledgerWith(inv, target.id, (f) => ({ ...f, tool: 'ask_the_oracle' }));
    expect(verify(clean, madeUpTool)).toContainEqual(
      expect.objectContaining({
        code: 'value_mismatch',
        message: expect.stringContaining('cannot be re-run') as string,
      }),
    );
  });

  it('a patch that reverts a change event that does not exist', () => {
    const issues = verify(
      edit((d) => {
        const r = d.recommendations[0];
        if (r !== undefined) r.patch = { revert: 'ev_99' };
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_evidence', location: 'recommendations[0]' }),
    );
  });

  it('a root cause tied to a hypothesis that does not exist', () => {
    const issues = verify(edit((d) => (d.rootCause.hypothesisId = 'hy_99')));
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'unsupported_logic', location: 'rootCause' }),
    );
  });
});

describe('2. mismatched numbers are rejected', () => {
  it('a quoted field that differs from the stored telemetry item', () => {
    const target = facts().find((f) => f.quantities.length > 0);
    if (target === undefined) throw new Error('fixture: no fact quotes a field');
    const q = target.quantities[0];
    if (q === undefined) throw new Error('unreachable');
    const stored = a.store.getEvidence(a.incidentId, q.evidenceId);
    expect(stored).toBeDefined();
    const ledger = ledgerWith(inv, target.id, (f) => ({
      ...f,
      quantities: f.quantities.map((x, i) => (i === 0 ? { ...x, value: x.value + 1 } : x)),
    }));
    const issues = verifyFacts(
      a.store,
      a.incidentId,
      ledger.entries.filter((e): e is FactEntry => e.type === 'FACT'),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'value_mismatch', location: `ledger:${target.id}` });
    expect(issues[0]?.message).toContain(
      `= ${String(q.value + 1)}, the store has ${String(q.value)}`,
    );
  });

  it('a quoted field the telemetry item does not have', () => {
    const target = facts().find((f) => f.quantities.length > 0);
    if (target === undefined) throw new Error('fixture: no fact quotes a field');
    const ledger = ledgerWith(inv, target.id, (f) => ({
      ...f,
      quantities: f.quantities.map((x, i) => (i === 0 ? { ...x, field: 'attributes.madeUp' } : x)),
    }));
    expect(verify(clean, ledger)).toContainEqual(
      expect.objectContaining({
        code: 'value_mismatch',
        message: expect.stringContaining('which that item does not have') as string,
      }),
    );
  });

  it('a derived quantity that the analyzers do not reproduce', () => {
    // The pool's mean utilization, nudged from what the store yields.
    const target = factByKey(inv, 'saturation.db.pool.incident.status');
    expect(target.derived.length).toBeGreaterThan(0);
    const ledger = ledgerWith(inv, target.id, (f) => ({
      ...f,
      derived: f.derived.map((x, i) => (i === 0 ? { ...x, value: x.value * 0.9 } : x)),
    }));
    const issues = verify(clean, ledger);
    expect(codes(issues)).toEqual(['value_mismatch']);
    expect(issues[0]?.message).toMatch(/is not reproduced by get_saturation.*vs recomputed/);
  });

  it('a fact statement whose numbers were edited', () => {
    const target = factByKey(inv, 'saturation.db.pool.incident.status');
    expect(target.statement).toContain('capacity 30');
    const ledger = ledgerWith(inv, target.id, (f) => ({
      ...f,
      statement: f.statement.replace('capacity 30', 'capacity 300'),
    }));
    expect(verify(clean, ledger)).toContainEqual(
      expect.objectContaining({
        code: 'value_mismatch',
        location: `ledger:${target.id}`,
        message: expect.stringContaining('statement differs from the recomputed one') as string,
      }),
    );
  });

  it('a finding whose verdict was flipped', () => {
    // "DB execution time is flat" turned into "not flat": the evidence for a slow database.
    const target = factByKey(inv, 'db_exec.incident.flat');
    expect(target.value).toBe(true);
    const ledger = ledgerWith(inv, target.id, (f) => ({ ...f, value: false }));
    expect(verify(clean, ledger)).toContainEqual(
      expect.objectContaining({
        code: 'value_mismatch',
        location: `ledger:${target.id}`,
        message: expect.stringContaining('value false vs recomputed true') as string,
      }),
    );
  });

  it('a fact moved in time', () => {
    const target = factByKey(inv, 'propagation.onset.db');
    const ledger = ledgerWith(inv, target.id, (f) => ({
      ...f,
      ...(f.occurredAt === undefined
        ? {}
        : { occurredAt: { ...f.occurredAt, tsUs: f.occurredAt.tsUs - 120_000_000 } }),
    }));
    expect(verify(clean, ledger)).toContainEqual(
      expect.objectContaining({
        code: 'value_mismatch',
        message: expect.stringContaining('time differs from the recomputed one') as string,
      }),
    );
  });

  it('a claim that quotes a number its cited facts do not contain', () => {
    // The cited fact says the pool has 30 connections; the claim says 50.
    const pool = factByKey(inv, 'saturation.db.pool.incident.status');
    const withNumber = (n: string): DiagnosisDraft =>
      edit((d) => {
        const step = d.causalChain[1];
        if (step === undefined) throw new Error('fixture');
        step.ledgerEntryIds = [pool.id];
        step.onsetEntryId = pool.id;
        step.statement = `The pool of ${n} connections filled up and requests began to wait.`;
      });
    expect(verify(withNumber('30'))).toEqual([]);
    const issues = verify(withNumber('50'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'ungrounded_number', location: 'causalChain[1]' });
    expect(issues[0]?.message).toContain('50');
  });

  it('a number that is real but belongs to a fact the claim does not cite', () => {
    // 30 is the pool capacity, but this step cites only the entry service's onset.
    const issues = verify(
      edit((d) => {
        const step = d.causalChain[2];
        if (step !== undefined) step.statement = `${step.statement} All 30 connections were busy.`;
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'ungrounded_number', location: 'causalChain[2]' }),
    );
  });

  it('a wrong time, a wrong percentage and a wrong "from" value in a patch', () => {
    expect(verify(edit((d) => (d.rootCause.statement += ' It started at T+9:12.')))).toContainEqual(
      expect.objectContaining({ code: 'ungrounded_number', location: 'rootCause' }),
    );
    expect(
      verify(
        edit((d) => d.unknowns.push('Whether the 42.5% of traffic on the old version matters.')),
      ),
    ).toContainEqual(
      expect.objectContaining({ code: 'ungrounded_number', location: 'unknowns[0]' }),
    );
    const patched = (from: number): DiagnosisDraft =>
      edit((d) => {
        const r = d.recommendations[1];
        if (r !== undefined) r.patch = { target: 'db.pool.capacity', from, to: 64 };
      });
    expect(verify(patched(30))).toEqual([]);
    expect(verify(patched(20))).toContainEqual(
      expect.objectContaining({ code: 'ungrounded_number', location: 'recommendations[1]' }),
    );
  });
});

describe('2b. numbers are matched by unit and field, not by magnitude', () => {
  /** The verdict on one causal step that cites `keys` and says `text`. */
  const stepWith = (keys: string[], text: string): VerifierIssue[] => {
    const ids = keys.map((k) => factByKey(inv, k).id);
    return verify(
      edit((d) => {
        const step = d.causalChain[1];
        if (step === undefined) throw new Error('fixture');
        step.ledgerEntryIds = [...ids, factByKey(inv, 'propagation.onset.db').id];
        step.onsetEntryId = factByKey(inv, 'propagation.onset.db').id;
        step.statement = text;
      }),
    ).filter((i) => i.location === 'causalChain[1]');
  };
  const ok = (keys: string[], text: string): void => {
    expect(stepWith(keys, text), text).toEqual([]);
  };
  const rejected = (keys: string[], text: string, token: string): void => {
    const issues = stepWith(keys, text);
    expect(issues, text).toEqual([
      expect.objectContaining({ code: 'ungrounded_number', location: 'causalChain[1]' }),
    ]);
    expect(issues[0]?.message, text).toContain(token);
  };

  it('a count of the right magnitude where the cited fact has a duration', () => {
    // propagation.onset.db: "resolution 49.7 ms". The old magnitude-only check accepted this.
    const onset = factByKey(inv, 'propagation.onset.db');
    expect(onset.statement).toContain('49.7 ms');
    ok([], 'The pool was observed full within 50 ms.');
    rejected([], 'A pool of 50 connections filled up.', '50');
  });

  it('a duration in the wrong unit', () => {
    const nested = factByKey(inv, 'hold_and_wait.incident.nested_wait');
    expect(nested.statement).toMatch(/hold p50 7\.51 s, p95 8\.01 s/);
    ok(['hold_and_wait.incident.nested_wait'], 'Transactions held their connection for 7510 ms.');
    rejected(
      ['hold_and_wait.incident.nested_wait'],
      'Transactions held their connection for 7.51 ms.',
      '7.51',
    );
  });

  it('a statistic attributed to the wrong field', () => {
    ok(['hold_and_wait.incident.nested_wait'], 'The p95 hold time was 8.01 s.');
    ok(['hold_and_wait.incident.nested_wait'], 'The median hold time was 7.51 s.');
    rejected(['hold_and_wait.incident.nested_wait'], 'The p95 hold time was 7.51 s.', '7.51');
    rejected(['hold_and_wait.incident.nested_wait'], 'The median hold time was 8.01 s.', '8.01');
  });

  it('a share where the cited fact has a count, and the reverse', () => {
    const pool = 'saturation.db.pool.incident.status';
    expect(factByKey(inv, pool).statement).toMatch(/capacity 30 .*utilization mean 99\.7%/);
    ok([pool], 'All 30 connections were in use, a mean utilization of 99.7%.');
    rejected([pool], 'Only 30% of the pool was in use.', '30');
    rejected([pool], 'The pool held 99.7 connections on average.', '99.7');
  });

  it('a quoted quantity whose unit or field does not match the stored telemetry item', () => {
    // ev_2 is quoted with its timestamp (µs) and its diff values (counts).
    const target = factByKey(inv, 'change.ev_2');
    const tsIndex = target.quantities.findIndex((q) => q.field === 'ts');
    expect(target.quantities[tsIndex]?.unit).toBe('us');
    const wrongUnit = ledgerWith(inv, target.id, (f) => ({
      ...f,
      quantities: f.quantities.map((q, i) => (i === tsIndex ? { ...q, unit: 'count' } : q)),
    }));
    expect(verify(clean, wrongUnit)).toContainEqual(
      expect.objectContaining({
        code: 'value_mismatch',
        location: `ledger:${target.id}`,
        message: expect.stringContaining('in unit "count", but that field is in "us"') as string,
      }),
    );
    // workers 20 -> 60: quoting the new value as the old one is the right magnitude, wrong field.
    const toIndex = target.quantities.findIndex((q) => q.field === 'diff.workers.to');
    expect(target.quantities[toIndex]?.value).toBe(60);
    const wrongField = ledgerWith(inv, target.id, (f) => ({
      ...f,
      quantities: f.quantities.map((q, i) =>
        i === toIndex ? { ...q, field: 'diff.workers.from' } : q,
      ),
    }));
    expect(verify(clean, wrongField)).toContainEqual(
      expect.objectContaining({
        code: 'value_mismatch',
        message: expect.stringContaining('diff.workers.from = 60, the store has 20') as string,
      }),
    );
  });
});

describe('3. a HYPOTHESIS used as a premise is rejected', () => {
  const hypothesisEntry = (): LedgerEntry => {
    const e = inv.ledger.find((x) => x.type === 'HYPOTHESIS');
    if (e === undefined) throw new Error('fixture: no hypothesis entry');
    return e;
  };

  it('the ledger refuses to record such an inference in the first place', () => {
    const ledger = Ledger.from(inv.ledger);
    expect(() =>
      ledger.addInference('investigator', 'So the DB is slow.', 'restating', [
        hypothesisEntry().id,
      ]),
    ).toThrow(/HYPOTHESIS cannot be a premise/);
  });

  it('a diagnosis citing a hypothesis as support', () => {
    const h = hypothesisEntry();
    const spots: [string, (d: DiagnosisDraft) => void][] = [
      ['rootCause', (d) => d.rootCause.ledgerEntryIds.push(h.id)],
      ['causalChain[0]', (d) => d.causalChain[0]?.ledgerEntryIds.push(h.id)],
      ['rejectedHypotheses[0]', (d) => d.rejectedHypotheses[0]?.ledgerEntryIds.push(h.id)],
      ['recommendations[0]', (d) => d.recommendations[0]?.ledgerEntryIds.push(h.id)],
    ];
    for (const [location, change] of spots) {
      expect(verify(edit(change)), location).toContainEqual(
        expect.objectContaining({
          code: 'hypothesis_as_premise',
          location,
          ledgerEntryIds: [h.id],
        }),
      );
    }
  });

  it('a root cause supported ONLY by its own hypothesis', () => {
    const h = inv.hypotheses.find((x) => x.id === clean.rootCause.hypothesisId);
    const issues = verify(edit((d) => (d.rootCause.ledgerEntryIds = [h?.ledgerEntryId ?? ''])));
    expect(codes(issues)).toEqual(['hypothesis_as_premise', 'unsupported_logic']);
  });

  it('an INFERENCE whose premise is a hypothesis, however it got into the ledger', () => {
    const h = hypothesisEntry();
    const smuggled: LedgerEntry = {
      id: 'le_zz1',
      author: 'investigator',
      type: 'INFERENCE',
      statement: 'The database is the bottleneck.',
      rule: 'assumed',
      premises: [h.id],
    };
    const ledger = Ledger.from([...inv.ledger, smuggled]);
    expect(verify(clean, ledger)).toContainEqual(
      expect.objectContaining({
        code: 'hypothesis_as_premise',
        location: 'ledger:le_zz1',
        ledgerEntryIds: ['le_zz1', h.id],
      }),
    );
  });

  it('a hypothesis laundered through a chain of inferences', () => {
    const h = hypothesisEntry();
    const fact = factByKey(inv, 'saturation.db.pool.incident.status');
    const step1: LedgerEntry = {
      id: 'le_zz1',
      author: 'investigator',
      type: 'INFERENCE',
      statement: 'The database is the bottleneck.',
      rule: 'assumed',
      premises: [fact.id, h.id],
    };
    const step2: LedgerEntry = {
      id: 'le_zz2',
      author: 'investigator',
      type: 'INFERENCE',
      statement: 'So the pool is full because queries are slow.',
      rule: 'chained',
      premises: [step1.id],
    };
    const issues = verify(clean, Ledger.from([...inv.ledger, step1, step2]));
    expect(issues.filter((i) => i.code === 'hypothesis_as_premise').map((i) => i.location)).toEqual(
      ['ledger:le_zz1', 'ledger:le_zz2'],
    );
  });

  it('an inference over facts alone is fine', () => {
    const ledger = Ledger.from(inv.ledger);
    const e = ledger.addInference(
      'investigator',
      'The pool filled before the entry service degraded.',
      'onset-order',
      [
        factByKey(inv, 'propagation.onset.db').id,
        factByKey(inv, 'propagation.onset.api-gateway').id,
      ],
    );
    const draft = edit((d) => d.causalChain[1]?.ledgerEntryIds.push(e.id));
    expect(verify(draft, ledger)).toEqual([]);
  });
});

describe('4. effect-before-cause chains are rejected', () => {
  const step = (key: string, statement: string): DiagnosisDraft['causalChain'][number] => {
    const f = factByKey(inv, key);
    return { statement, ledgerEntryIds: [f.id], onsetEntryId: f.id };
  };
  const chain = (...steps: DiagnosisDraft['causalChain']): DiagnosisDraft =>
    edit((d) => (d.causalChain = steps));

  it('the real chain reversed: the user-facing symptom "causing" the pool to fill', () => {
    const issues = verify(
      edit((d) => {
        d.causalChain.reverse();
      }),
    );
    const violations = issues.filter((i) => i.code === 'temporal_precedence');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.message).toMatch(/effect before cause/);
    expect(codes(issues)).toEqual(['temporal_precedence']);
  });

  it('blaming a later event for an earlier one, with both onsets cited', () => {
    // Pool onset (after T+10:00) named as the cause of the config change at T+6:30.
    const cause = factByKey(inv, 'propagation.onset.db');
    const effect = factByKey(inv, 'change.ev_1');
    const issues = verify(
      chain(
        step('propagation.onset.db', 'The pool filled up.'),
        step('change.ev_1', 'That led to a config change.'),
      ),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'temporal_precedence',
        location: 'causalChain[1]',
        ledgerEntryIds: [cause.id, effect.id],
      }),
    );
  });

  it('a violation between non-adjacent steps', () => {
    const issues = verify(
      chain(
        step('propagation.onset.db', 'The pool filled up.'),
        step('propagation.onset.api-gateway', 'The entry service degraded.'),
        step('change.ev_2', 'A deploy followed.'),
      ),
    );
    const at = issues.filter((i) => i.code === 'temporal_precedence').map((i) => i.location);
    expect(at).toEqual(['causalChain[2]', 'causalChain[2]']);
  });

  it('does not invent a violation when two onsets are too close to order', () => {
    // These two onsets lie within each other's resolution: either order is possible.
    const x = factByKey(inv, 'propagation.onset.checkout').occurredAt;
    const y = factByKey(inv, 'propagation.onset.api-gateway').occurredAt;
    if (x === undefined || y === undefined) throw new Error('fixture: undated onsets');
    expect(Math.abs(x.tsUs - y.tsUs)).toBeLessThan(Math.min(x.resolutionUs, y.resolutionUs));
    for (const order of [
      ['propagation.onset.checkout', 'propagation.onset.api-gateway'],
      ['propagation.onset.api-gateway', 'propagation.onset.checkout'],
    ] as const) {
      const issues = verify(chain(step(order[0], 'First.'), step(order[1], 'Then.')));
      expect(issues.filter((i) => i.code === 'temporal_precedence')).toEqual([]);
    }
  });

  it('a step that cannot be placed in time', () => {
    const undated = factByKey(inv, 'hold_and_wait.incident.holder');
    expect(undated.occurredAt).toBeUndefined();
    const notDated = verify(
      edit((d) => {
        const s = d.causalChain[1];
        if (s !== undefined) {
          s.ledgerEntryIds = [undated.id];
          s.onsetEntryId = undated.id;
          s.statement = 'Connections were held.';
        }
      }),
    );
    expect(notDated).toContainEqual(
      expect.objectContaining({ code: 'temporal_precedence', location: 'causalChain[1]' }),
    );
    const notCited = verify(
      edit((d) => {
        const s = d.causalChain[1];
        if (s !== undefined) s.onsetEntryId = factByKey(inv, 'change.ev_1').id;
      }),
    );
    expect(notCited).toContainEqual(
      expect.objectContaining({
        code: 'temporal_precedence',
        location: 'causalChain[1]',
        message: expect.stringContaining("must be one of the step's ledgerEntryIds") as string,
      }),
    );
  });
});

describe('conclusions must match the hypothesis tests', () => {
  const byKind = (kind: string): string => inv.hypotheses.find((h) => h.kind === kind)?.id ?? '';

  it('a rejected hypothesis cannot be the root cause', () => {
    for (const kind of ['db_slow', 'pool_capacity']) {
      const issues = verify(
        edit((d) => {
          d.rootCause.hypothesisId = byKind(kind);
          d.rejectedHypotheses = d.rejectedHypotheses.filter(
            (r) => r.hypothesisId !== byKind(kind),
          );
        }),
      );
      expect(issues, kind).toContainEqual(
        expect.objectContaining({
          code: 'unsupported_logic',
          location: 'rootCause',
          message: expect.stringContaining('which the tests rejected') as string,
        }),
      );
    }
  });

  it('a supported hypothesis cannot be listed as rejected, and a rejected one cannot be left out', () => {
    const supported = byKind('hold_and_wait');
    const listed = verify(
      edit((d) =>
        d.rejectedHypotheses.push({
          hypothesisId: supported,
          reason: 'Not convincing.',
          ledgerEntryIds: [factByKey(inv, 'db_exec.incident.flat').id],
        }),
      ),
    );
    expect(listed).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_logic',
        location: `rejectedHypotheses[${String(clean.rejectedHypotheses.length)}]`,
      }),
    );
    const omitted = verify(edit((d) => (d.rejectedHypotheses = [])));
    expect(omitted.filter((i) => i.location === 'rejectedHypotheses')).toHaveLength(2);
  });

  it('a rejection must cite the fact that contradicted the hypothesis, and the root cause a fact that supported it', () => {
    const unrelated = factByKey(inv, 'change.ev_1').id;
    const rejection = verify(
      edit((d) => {
        const r = d.rejectedHypotheses[0];
        if (r !== undefined) r.ledgerEntryIds = [unrelated];
      }),
    );
    expect(rejection).toContainEqual(
      expect.objectContaining({ code: 'unsupported_logic', location: 'rejectedHypotheses[0]' }),
    );
    const root = verify(edit((d) => (d.rootCause.ledgerEntryIds = [unrelated])));
    expect(root).toContainEqual(
      expect.objectContaining({ code: 'unsupported_logic', location: 'rootCause' }),
    );
  });

  it('services that are not in the telemetry are rejected', () => {
    const issues = verify(
      edit((d) => {
        d.affectedServices.push('billing');
        const s = d.causalChain[0];
        if (s !== undefined) s.service = 'auth';
      }),
    );
    expect(issues.map((i) => i.location).sort()).toEqual(['affectedServices', 'causalChain[0]']);
  });
});
