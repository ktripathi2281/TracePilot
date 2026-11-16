import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FactEntry, Hypothesis, Prediction } from '@tracepilot/schema';
import { afterAll, describe, expect, it } from 'vitest';
import { computeConfidence } from './confidence.ts';
import { contentWords, extractNumbers, ungroundedNumbers } from './grounding.ts';
import {
  ProposeHypothesesInput,
  statusOf,
  validateProposal,
  type CoverageRule,
} from './hypotheses.ts';
import { Ledger, LedgerError } from './ledger.ts';
import { describeLlmError } from './llm/anthropic.ts';
import { CassetteLlm, CassetteMissError, hashRequest } from './llm/cassette.ts';
import { LoggingLlm } from './llm/log.ts';
import {
  DEFAULT_MODEL,
  DEFAULT_TOKEN_BUDGET,
  cassettePath,
  llmConfigFromEnv,
} from './llm/config.ts';
import type { LlmClient, LlmRequest } from './llm/types.ts';
import { BudgetExceededError, UsageMeter } from './llm/usage.ts';
import { loadPrompt } from './prompts.ts';
import { ScriptedLlm } from './testing.ts';
import { DATA_TOOLS } from './tools/registry.ts';
import { parseToolArgs, toolSpecs } from './tools/runner.ts';
import { callKey, canonicalJson, type Finding } from './tools/types.ts';

const fact = (over: Partial<FactEntry> = {}): FactEntry => ({
  id: 'le_1',
  author: 'investigator',
  type: 'FACT',
  statement:
    'db.pool in the incident window: saturated; utilization mean 99.7%; queue mean 257.148; pool observed full at T+10:00.050; p99 16.33 s.',
  tool: 'get_saturation',
  args: { window: 'incident' },
  findingKey: 'saturation.db.pool.incident.status',
  value: 'saturated',
  evidenceIds: ['mt_db_pool_in_use_605000000'],
  quantities: [
    { evidenceId: 'mt_db_pool_in_use_605000000', field: 'value', value: 30, unit: 'count' },
  ],
  derived: [{ name: 'holdP50Us', value: 7_556_614, unit: 'us' }],
  occurredAt: { tsUs: 605_000_000, resolutionUs: 5_000_000 },
  ...over,
});

describe('number grounding', () => {
  const facts = [fact()];

  it('accepts numbers copied or correctly rounded from cited facts, with unit conversion', () => {
    for (const text of [
      'Utilization was 99.7% and the queue averaged 257.',
      'Utilization was about 100 %.',
      'The pool held 30 connections.',
      'p99 reached 16.33 s (16330 ms).',
      'Transactions held a connection for 7.56 s.', // 7_556_614 µs from a derived quantity
      'The p50 hold time was 7.56 s.',
      'The pool was full at T+10:00.050, i.e. by T+10:00.',
      'It was saturated from T+10:05.',
    ]) {
      expect(ungroundedNumbers(text, facts), text).toEqual([]);
    }
  });

  it('rejects numbers and times that no cited fact contains', () => {
    expect(ungroundedNumbers('Utilization was 87.3%.', facts)).toEqual(['87.3']);
    expect(ungroundedNumbers('p99 reached 4.2 s and 9000 requests failed.', facts)).toEqual([
      '4.2',
      '9000',
    ]);
    expect(ungroundedNumbers('It began at T+9:41.', facts)).toEqual(['T+9:41']);
    expect(ungroundedNumbers('The pool held 30 connections.', [])).toEqual(['30']);
    // Right magnitude, wrong unit or field.
    expect(ungroundedNumbers('The pool held 30 ms of work.', facts)).toEqual(['30']);
    expect(ungroundedNumbers('Only 30% of the pool was used.', facts)).toEqual(['30']);
    expect(ungroundedNumbers('The p95 hold time was 7.56 s.', facts)).toEqual(['7.56']);
    expect(ungroundedNumbers('The queue held 99.7 requests.', facts)).toEqual(['99.7']);
    // A bare count must share a subject word with the quantity it repeats.
    expect(ungroundedNumbers('The pool held 30 connections.', facts)).toEqual([]);
    expect(ungroundedNumbers('Then 30 requests failed.', facts)).toEqual(['30']);
    expect(ungroundedNumbers('So 30.', facts)).toEqual(['30']);
  });

  it('reads the subject words of a phrase or identifier', () => {
    expect(contentWords('mt_db_pool_in_use_605000000')).toEqual(['pool', 'use']);
    expect(contentWords('holdP95Us')).toEqual(['hold']);
    expect(contentWords('the queues of all replicas')).toEqual(['queue', 'replica']);
  });

  it('ignores digits inside identifiers and versions', () => {
    const text = 'latency_p99 of checkout v2.4.1 after ev_2 (see le_12) returned 5xx; p95 too.';
    expect(extractNumbers(text).numbers).toEqual([]);
    expect(ungroundedNumbers(text, [])).toEqual([]);
  });

  it('needs no facts for text without numbers', () => {
    expect(ungroundedNumbers('The pool was full while the database was idle.', [])).toEqual([]);
  });
});

describe('ledger', () => {
  const finding = (key: string): Finding => ({
    key,
    statement: `statement ${key}`,
    value: true,
    evidenceIds: ['ev_1'],
    quantities: [],
    derived: [],
  });

  it('creates one FACT per finding of a tool call, however often it is seen', () => {
    const ledger = new Ledger();
    const first = ledger.recordFindings('investigator', 'tool_a', { window: 'incident' }, [
      finding('k1'),
      finding('k2'),
    ]);
    const again = ledger.recordFindings('skeptic', 'tool_a', { window: 'incident' }, [
      finding('k1'),
    ]);
    const other = ledger.recordFindings('skeptic', 'tool_a', { window: 'baseline' }, [
      finding('k1'),
    ]);
    expect(first.map((f) => f.id)).toEqual(['le_1', 'le_2']);
    expect(again[0]?.id).toBe('le_1');
    expect(again[0]?.author).toBe('investigator');
    expect(other[0]?.id).toBe('le_3');
    expect(ledger.entries).toHaveLength(3);
  });

  it('refuses an inference with an unknown premise or a HYPOTHESIS premise', () => {
    const ledger = new Ledger();
    const [f] = ledger.recordFindings('investigator', 't', {}, [finding('k')]);
    const h = ledger.addHypothesis('investigator', 'maybe the DB is slow', 'hy_1');
    expect(() => ledger.addInference('investigator', 's', 'r', ['le_zz'])).toThrow(LedgerError);
    expect(() => ledger.addInference('investigator', 's', 'r', [f?.id ?? '', h.id])).toThrow(
      /HYPOTHESIS cannot be a premise/,
    );
    const inf = ledger.addInference('investigator', 's', 'r', [f?.id ?? '']);
    const inf2 = ledger.addInference('skeptic', 's2', 'r', [inf.id]);
    expect(ledger.factsBehind([inf2.id]).map((x) => x.id)).toEqual([f?.id]);
    expect(ledger.factsBehind([h.id])).toEqual([]);
  });

  it('round-trips through its stored entries', () => {
    const ledger = new Ledger();
    ledger.recordFindings('investigator', 't', { a: 1 }, [finding('k')]);
    ledger.addHypothesis('investigator', 'h', 'hy_1');
    const copy = Ledger.from(ledger.entries);
    expect(copy.entries).toEqual(ledger.entries);
    expect(copy.recordFindings('skeptic', 't', { a: 1 }, [finding('k')])[0]?.id).toBe('le_1');
    expect(copy.addHypothesis('skeptic', 'h2', 'hy_2').id).toBe('le_3');
  });
});

describe('tool plumbing', () => {
  it('serializes arguments canonically, so equal calls have equal keys', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe('{"a":{"d":[1,2]},"b":1}');
    expect(callKey('t', { window: 'incident', route: 'x' })).toBe(
      callKey('t', { route: 'x', window: 'incident' }),
    );
    expect(callKey('t', { window: 'incident' })).not.toBe(callKey('t', { window: 'baseline' }));
  });

  it('exposes every data tool with an object schema and documented finding keys', () => {
    const specs = toolSpecs(DATA_TOOLS);
    expect(specs.map((s) => s.name)).toEqual([
      'get_incident_window',
      'list_change_events',
      'get_metric_series',
      'detect_anomalies',
      'build_timeline',
      'get_dependency_graph',
      'attribute_latency',
      'get_saturation',
      'analyze_propagation',
      'search_logs',
      'get_trace',
      'compare_windows',
      'analyze_hold_and_wait',
      'correlate_changes',
      'get_pod_events',
    ]);
    for (const s of specs) {
      expect(s.input_schema.type, s.name).toBe('object');
      expect(s.description, s.name).toMatch(/Findings?[: (]/);
      expect(JSON.stringify(s.input_schema)).not.toContain('$schema');
    }
  });

  it('validates tool arguments and explains what is wrong', () => {
    expect(parseToolArgs('get_saturation', { window: 'incident' })).toEqual({
      args: { window: 'incident' },
    });
    expect(parseToolArgs('get_saturation', { window: 'yesterday' })).toHaveProperty('error');
    expect(parseToolArgs('get_saturation', { window: 'incident', extra: 1 })).toHaveProperty(
      'error',
    );
    expect(parseToolArgs('no_such_tool', {})).toMatchObject({
      error: expect.stringContaining('unknown tool') as string,
    });
  });
});

describe('hypothesis proposals', () => {
  const HW = { tool: 'analyze_hold_and_wait', args: { window: 'incident' } };
  const DB = { tool: 'compare_windows', args: { subject: 'db_queries' } };
  const p = (
    base: { tool: string; args: Record<string, unknown> },
    findingKey: string,
    expected: string | boolean,
    op?: 'is' | 'is_not',
  ) => ({
    statement: `${findingKey} ${String(expected)}`,
    ...base,
    findingKey,
    expected,
    ...(op === undefined ? {} : { op }),
  });
  const proposal = (
    over: (h: ProposeHypothesesInput['hypotheses']) => void = () => undefined,
  ): ProposeHypothesesInput => {
    const hypotheses: ProposeHypothesesInput['hypotheses'] = [
      {
        kind: 'hold_and_wait',
        title: 'HW',
        statement: 's',
        predictions: [
          p(HW, 'hold_and_wait.incident.idle_held', true),
          p(DB, 'db_exec.incident.flat', true),
        ],
      },
      {
        kind: 'pool_capacity',
        title: 'PC',
        statement: 's',
        predictions: [
          p(HW, 'hold_and_wait.incident.idle_held', false),
          p(DB, 'db_exec.incident.flat', true),
        ],
      },
      {
        kind: 'db_slow',
        title: 'DB',
        statement: 's',
        predictions: [
          p(DB, 'db_exec.incident.flat', false),
          p(HW, 'hold_and_wait.incident.idle_held', false),
        ],
      },
    ];
    over(hypotheses);
    return ProposeHypothesesInput.parse({ hypotheses });
  };
  const rule: CoverageRule = {
    kinds: ['pool_capacity', 'hold_and_wait', 'db_slow'],
    because: 'db.pool is saturated',
  };

  it('accepts a proposal whose required kinds are pairwise discriminated', () => {
    const r = validateProposal(proposal(), [rule]);
    expect(r.problems).toEqual([]);
    expect(r.checks.flat().every((c) => c.op === 'is')).toBe(true);
  });

  it('requires the kinds a coverage rule names', () => {
    const r = validateProposal(
      proposal((h) => ((h[2] as (typeof h)[number]).kind = 'other')),
      [rule],
    );
    expect(r.problems.join('\n')).toMatch(
      /missing required hypothesis kind\(s\) db_slow: db\.pool is saturated/,
    );
  });

  it('rejects required kinds that make the same predictions', () => {
    // "pool too small" now expects idle-held connections too: nothing separates it from hold-and-wait.
    const r = validateProposal(
      proposal(
        (h) =>
          ((h[1] as (typeof h)[number]).predictions[0] = p(
            HW,
            'hold_and_wait.incident.idle_held',
            true,
          )),
      ),
      [rule],
    );
    expect(r.problems.join('\n')).toMatch(/"HW" and "PC" are not discriminated/);
  });

  it('rejects a kind whose defining prediction is missing or inverted', () => {
    // "Pool too small" tested as if it were hold-and-wait, and vice versa: labels swapped.
    const swapped = validateProposal(
      proposal((h) => {
        (h[0] as (typeof h)[number]).kind = 'pool_capacity';
        (h[1] as (typeof h)[number]).kind = 'hold_and_wait';
      }),
      [rule],
    );
    expect(swapped.problems.join('\n')).toMatch(
      /"HW" is of kind pool_capacity and must include the prediction that defines that kind/,
    );
    expect(swapped.problems.join('\n')).toMatch(/"PC" is of kind hold_and_wait and must include/);
    const noDbPrediction = validateProposal(
      proposal(
        (h) =>
          ((h[2] as (typeof h)[number]).predictions = [
            p(HW, 'hold_and_wait.incident.idle_held', false),
            p(DB, 'db_exec.incident.flat', true, 'is_not'),
          ]),
      ),
      [rule],
    );
    expect(noDbPrediction.problems).toEqual([]);
    const dbFlat = validateProposal(
      proposal(
        (h) => ((h[2] as (typeof h)[number]).predictions[0] = p(DB, 'db_exec.incident.flat', true)),
      ),
      [rule],
    );
    expect(dbFlat.problems.join('\n')).toMatch(/"DB" is of kind db_slow and must include/);
  });

  it('treats is / is_not on the same finding as discriminating, and different windows as different findings', () => {
    const viaIsNot = validateProposal(
      proposal(
        (h) =>
          ((h[1] as (typeof h)[number]).predictions[0] = p(
            HW,
            'hold_and_wait.incident.idle_held',
            true,
            'is_not',
          )),
      ),
      [rule],
    );
    expect(viaIsNot.problems).toEqual([]);
    const otherWindow = validateProposal(
      proposal(
        (h) =>
          ((h[1] as (typeof h)[number]).predictions[0] = p(
            { tool: 'analyze_hold_and_wait', args: { window: 'baseline' } },
            'hold_and_wait.incident.idle_held',
            false,
          )),
      ),
      [rule],
    );
    expect(otherWindow.problems.join('\n')).toMatch(/"HW" and "PC" are not discriminated/);
  });

  it('rejects predictions on unknown tools or with invalid arguments, and too few hypotheses', () => {
    const r = validateProposal(
      proposal(
        (h) =>
          ((h[0] as (typeof h)[number]).predictions[0] = p(
            { tool: 'read_minds', args: {} },
            'x',
            true,
          )),
      ),
      [],
    );
    expect(r.problems.join('\n')).toMatch(/unknown tool "read_minds"/);
    expect(
      ProposeHypothesesInput.safeParse({ hypotheses: proposal().hypotheses.slice(0, 2) }).success,
    ).toBe(false);
  });

  it('normalizes "true"/"false" strings so they compare with boolean findings', () => {
    const r = validateProposal(
      proposal(
        (h) =>
          ((h[0] as (typeof h)[number]).predictions[0] = p(
            HW,
            'hold_and_wait.incident.idle_held',
            'true',
          )),
      ),
      [rule],
    );
    expect(r.problems).toEqual([]);
    expect(r.checks[0]?.[0]?.expected).toBe(true);
  });

  it('scores a hypothesis from prediction results only', () => {
    const pred = (result: Prediction['result']): Prediction => ({ result }) as Prediction;
    expect(statusOf([pred('supported'), pred('supported')])).toBe('supported');
    expect(statusOf([pred('supported'), pred('contradicted'), pred('supported')])).toBe('rejected');
    expect(statusOf([pred('supported'), pred('inconclusive')])).toBe('supported');
    expect(statusOf([pred('supported'), pred('inconclusive'), pred('inconclusive')])).toBe(
      'inconclusive',
    );
    expect(statusOf([pred('inconclusive')])).toBe('inconclusive');
  });
});

describe('confidence rubric', () => {
  const hyp = (
    id: string,
    results: Prediction['result'][],
    status: Hypothesis['status'],
  ): Hypothesis =>
    ({ id, status, predictions: results.map((result) => ({ result })) }) as Hypothesis;
  const root = hyp('hy_1', ['supported', 'supported', 'supported', 'inconclusive'], 'supported');
  const others = [root, hyp('hy_2', ['contradicted'], 'rejected')];
  const skeptic = (
    verdict: 'holds' | 'weakened' | 'refuted',
    precedence: 'consistent' | 'violated' = 'consistent',
  ) =>
    ({ againstLeading: [{ verdict }], temporalPrecedence: { verdict: precedence } }) as Parameters<
      typeof computeConfidence
    >[2];

  it('is the share of supported predictions when nothing is open', () => {
    expect(computeConfidence(root, others, skeptic('holds'), [])).toMatchObject({
      score: 0.75,
      level: 'high',
      basis: { supportedPredictions: 3, inconclusivePredictions: 1, unresolvedContradictions: 0 },
    });
  });

  it('drops for refutations, violated precedence, open verifier issues and undiscriminated alternatives', () => {
    expect(computeConfidence(root, others, skeptic('refuted'), []).score).toBe(0.5);
    expect(computeConfidence(root, others, skeptic('weakened', 'violated'), []).score).toBe(0.55);
    const issue = {
      code: 'ungrounded_number' as const,
      location: 'rootCause',
      message: 'm',
      ledgerEntryIds: [],
    };
    expect(computeConfidence(root, others, skeptic('holds'), [issue, issue])).toMatchObject({
      score: 0.45,
      level: 'low',
    });
    expect(computeConfidence(root, [root], null, []).score).toBe(0.55);
    expect(computeConfidence(root, others, null, []).score).toBe(0.65);
  });
});

describe('token budget', () => {
  it('counts every token read or written and refuses to start a call once the budget is spent', () => {
    const meter = new UsageMeter(10_000);
    meter.assertWithinBudget('investigator');
    meter.add('investigator', 'claude-sonnet-5-5', {
      inputTokens: 4000,
      outputTokens: 1000,
      cacheReadTokens: 3000,
      cacheCreationTokens: 1000,
    });
    meter.assertWithinBudget('skeptic');
    meter.add('skeptic', 'claude-sonnet-5-5', {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(meter.totalTokens).toBe(10_500);
    expect(() => meter.assertWithinBudget('verifier')).toThrow(BudgetExceededError);
    const s = meter.summary();
    expect(s).toMatchObject({
      calls: 2,
      totalTokens: 10_500,
      budgetTokens: 10_000,
      byRole: {
        investigator: { calls: 1, totalTokens: 9000 },
        skeptic: { calls: 1, totalTokens: 1500 },
      },
    });
    // 5000 in × $2 + 1000 cache-write × $2.50 + 3000 cache-read × $0.10 + 1500 out × $10, per million
    expect(s.estimatedCostUsd).toBeCloseTo(0.0278, 4);
  });

  it('reports no cost for a model without a known price', () => {
    const meter = new UsageMeter(100);
    meter.add('investigator', 'some-future-model', {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(meter.summary().estimatedCostUsd).toBeNull();
    expect(() => new UsageMeter(0)).toThrow();
  });
});

describe('LLM configuration', () => {
  it('has the brief’s defaults', () => {
    const c = llmConfigFromEnv({}, '.data');
    expect(c).toMatchObject({
      mode: 'live',
      model: DEFAULT_MODEL,
      verifierModel: DEFAULT_MODEL,
      effort: 'medium',
      maxTokensPerInvestigation: DEFAULT_TOKEN_BUDGET,
      fallbacks: false,
    });
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5');
    expect(cassettePath(c, 'in_abc')).toBe(join('.data', 'cassettes', 'in_abc.json'));
  });

  it('reads overrides and rejects bad values', () => {
    const c = llmConfigFromEnv(
      {
        TRACEPILOT_LLM: 'replay',
        TRACEPILOT_MODEL: 'claude-opus-5-5',
        TRACEPILOT_VERIFIER_MODEL: 'claude-fable-5-2',
        TRACEPILOT_EFFORT: 'high',
        MAX_TOKENS_PER_INVESTIGATION: '250000',
        TRACEPILOT_CASSETTE_DIR: 'tapes',
        TRACEPILOT_LLM_FALLBACKS: 'on',
      },
      '.data',
    );
    expect(c).toEqual({
      mode: 'replay',
      model: 'claude-opus-5-5',
      verifierModel: 'claude-fable-5-2',
      effort: 'high',
      maxTokensPerInvestigation: 250_000,
      cassetteDir: 'tapes',
      fallbacks: true,
    });
    expect(() => llmConfigFromEnv({ TRACEPILOT_LLM: 'offline' }, '.')).toThrow(
      /live, record or replay/,
    );
    expect(() => llmConfigFromEnv({ MAX_TOKENS_PER_INVESTIGATION: 'lots' }, '.')).toThrow(
      /positive integer/,
    );
    expect(() => llmConfigFromEnv({ TRACEPILOT_EFFORT: 'extreme' }, '.')).toThrow();
  });
});

describe('API errors', () => {
  it('explains missing credentials in one line and leaves unrelated errors alone', () => {
    const sdkMessage =
      'Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.';
    expect(describeLlmError(new Error(sdkMessage))).toMatch(
      /no API credentials found\. Set ANTHROPIC_API_KEY/,
    );
    expect(describeLlmError(new Error('disk full'))).toBeNull();
    expect(describeLlmError('nope')).toBeNull();
  });
});

describe('cassettes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracepilot-cassette-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (text: string): LlmRequest => ({
    model: 'm',
    system: 'sys',
    messages: [{ role: 'user', content: text }],
    tools: [],
    maxTokens: 100,
    effort: 'medium',
  });
  // Stand-in for the live API (no network in tests). It claims mode `live` so the live-cassette
  // paths can be exercised; the files it produces are test artifacts in a temp directory.
  const upstream = (): LlmClient & { requests: LlmRequest[] } => {
    const scripted = new ScriptedLlm((r) => `echo ${String(r.messages[0]?.content)}`);
    return {
      mode: 'live',
      requests: scripted.requests,
      complete: (r) => scripted.complete(r),
    };
  };

  it('record: calls the API for new requests, saves them, and reuses what is already recorded', async () => {
    const path = join(dir, 'a.json');
    const live = upstream();
    const rec = new CassetteLlm('record', path, live);
    const first = await rec.complete(request('one'));
    await rec.complete(request('two'));
    await rec.complete(request('one'));
    expect(live.requests).toHaveLength(2);
    expect([rec.recorded, rec.replayed, rec.size]).toEqual([2, 1, 2]);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { entries: { hash: string }[] };
    expect(file.entries.map((e) => e.hash)).toEqual([
      hashRequest(request('one')),
      hashRequest(request('two')),
    ]);

    // A second recording session resumes: nothing already recorded is requested again.
    const live2 = upstream();
    const resumed = new CassetteLlm('record', path, live2);
    expect(await resumed.complete(request('one'))).toEqual(first);
    await resumed.complete(request('three'));
    expect(live2.requests).toHaveLength(1);
  });

  it('replay: answers only from the cassette and fails loudly on anything else', async () => {
    const path = join(dir, 'b.json');
    const recorded = await new CassetteLlm('record', path, upstream()).complete(request('hello'));
    const replay = new CassetteLlm('replay', path);
    expect(replay.mode).toBe('replay');
    expect(await replay.complete(request('hello'))).toEqual(recorded);
    await expect(replay.complete(request('hello!'))).rejects.toThrow(CassetteMissError);
    await expect(
      replay.complete({ ...request('hello'), system: 'changed prompt' }),
    ).rejects.toThrow(/prompts, tools or telemetry differ.*recorded with m.medium/);
    expect(() => new CassetteLlm('replay', join(dir, 'missing.json'))).toThrow(
      /Record one with TRACEPILOT_LLM=record/,
    );
    expect(() => new CassetteLlm('record', join(dir, 'c.json'))).toThrow(/needs a live client/);
  });

  it('remembers what recorded it: a cassette made by a test double never replays as a model run', async () => {
    const path = join(dir, 'scripted.json');
    const double = new ScriptedLlm(() => 'scripted answer');
    const rec = new CassetteLlm('record', path, double);
    expect(rec.mode).toBe('scripted');
    await rec.complete(request('q'));
    expect((JSON.parse(readFileSync(path, 'utf8')) as { upstream: string }).upstream).toBe(
      'scripted',
    );
    const replay = new CassetteLlm('replay', path);
    expect(replay.mode).toBe('scripted');
    await expect(replay.complete(request('other'))).rejects.toThrow(CassetteMissError);
    // Live responses are never mixed into it, nor scripted ones into a live cassette.
    expect(() => new CassetteLlm('record', path, upstream())).toThrow(
      /refusing to add live responses/,
    );
    const livePath = join(dir, 'live.json');
    await new CassetteLlm('record', livePath, upstream()).complete(request('q'));
    expect(new CassetteLlm('replay', livePath).mode).toBe('replay');
    expect(() => new CassetteLlm('record', livePath, double)).toThrow(
      /refusing to add scripted responses/,
    );
  });

  it('logs every request and response, including failures', async () => {
    const path = join(dir, 'logs', 'calls.jsonl');
    let n = 0;
    const flaky = new ScriptedLlm(() => {
      if (++n === 2) throw new Error('overloaded');
      return 'ok';
    });
    const logged = new LoggingLlm(flaky, path);
    expect(logged.mode).toBe('scripted');
    await logged.complete(request('first'));
    await expect(logged.complete(request('second'))).rejects.toThrow('overloaded');
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      call: 1,
      mode: 'scripted',
      request: {
        hash: hashRequest(request('first')),
        model: 'm',
        messages: 1,
        newest: { content: 'first' },
      },
      response: { stopReason: 'end_turn', usage: { inputTokens: 1000 } },
    });
    expect(lines[1]).toMatchObject({ call: 2, error: 'Error: overloaded' });
    expect(lines[1]).not.toHaveProperty('response');
  });

  it('keys on the whole request', () => {
    const base = request('x');
    const hashes = new Set(
      [
        base,
        { ...base, model: 'm2' },
        { ...base, effort: 'high' as const },
        { ...base, maxTokens: 101 },
        {
          ...base,
          tools: [{ name: 't', description: 'd', input_schema: { type: 'object' as const } }],
        },
      ].map(hashRequest),
    );
    expect(hashes.size).toBe(5);
    expect(hashRequest(request('x'))).toBe(hashRequest(base));
  });
});

describe('prompts', () => {
  it('are versioned files whose rationale comment is not sent to the model', () => {
    for (const name of ['investigator', 'skeptic', 'verifier'] as const) {
      const raw = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
      expect(raw, name).toMatch(/^<!--[\s\S]*Rationale[\s\S]*?-->/);
      const sent = loadPrompt(name);
      expect(sent, name).not.toContain('<!--');
      expect(sent.length, name).toBeGreaterThan(500);
    }
  });

  it('name no structural fix the replay can model, only example variants', () => {
    for (const name of ['investigator', 'skeptic', 'verifier'] as const) {
      const text = loadPrompt(name);
      expect(text, name).not.toMatch(/release-connection-before-calls/);
      expect(text, name).not.toMatch(/releas\w* (its|the|a) (pooled )?connection/i);
      expect(text, name).not.toMatch(/before (it )?calls? other services/i);
    }
    // The investigator describes the variant form generically, with examples that are not it.
    expect(loadPrompt('investigator')).toMatch(/"variant": "<name>"/);
  });

  it('contain nothing about a specific system or scenario', () => {
    for (const name of ['investigator', 'skeptic', 'verifier'] as const) {
      expect(loadPrompt(name), name).not.toMatch(
        /checkout|inventory|payment|api-gateway|pool-exhaustion|ev_\d|reserve|v2\.4/i,
      );
    }
  });
});
