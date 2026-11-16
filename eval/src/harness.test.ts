// The eval harness must catch bad diagnoses, not only pass good ones. Each test below plays the
// model with a scripted double that does one thing wrong, and checks the score that should drop.

import { readFileSync } from 'node:fs';
import type { LlmRequest } from '@tracepilot/agents';
import {
  ScriptedLlm,
  protocolScript,
  seenFacts,
  type Script,
  type ScriptedCall,
} from '@tracepilot/agents/testing';
import { describe, expect, it } from 'vitest';
import { evaluateScenario, resultsTable, type EvalResult } from './harness.ts';

const A = 'pool-exhaustion';

/** The protocol script with its submit_diagnosis input rewritten by `change`. */
const diagnosisWith =
  (change: (input: Record<string, unknown>, request: LlmRequest) => void): Script =>
  (request) => {
    const out = protocolScript()(request);
    if (typeof out === 'string') return out;
    return out.map((c): ScriptedCall => {
      if (c.name !== 'submit_diagnosis') return c;
      const input = structuredClone(c.input) as Record<string, unknown>;
      change(input, request);
      return { name: c.name, input };
    });
  };
const run = (script: Script): Promise<EvalResult> =>
  evaluateScenario({ scenario: A, scripted: new ScriptedLlm(script) });

describe('eval harness', () => {
  it('scores the protocol on scenario A as a pass, labelled as a scripted fixture', async () => {
    const r = await evaluateScenario({ scenario: A, investigator: 'scripted' });
    expect(r).toMatchObject({
      investigator: { source: 'scripted fixture', model: 'none (scripted fixture)' },
      error: null,
      rootCause: { got: 'hold_and_wait', culpritCited: true, match: true },
      evidence: { rate: 1 },
      hallucinations: 0,
      redHerrings: { notBlamed: true },
      skeptic: { challenged: true },
      patch: {
        recommended: 'revert ev_2',
        addresses: 'cause',
        verdict: 'resolves',
        improves: true,
      },
      pass: true,
    });
    expect(r.alternativesRejected).toEqual(['pool_capacity', 'db_slow']);
  }, 120_000);

  it('catches a diagnosis that blames the red-herring config change', async () => {
    const r = await run(
      diagnosisWith((input, request) => {
        const herring = seenFacts(request).get('change.ev_1')?.id ?? '';
        const chain = input['causalChain'] as {
          ledgerEntryIds: string[];
          onsetEntryId: string;
          statement: string;
        }[];
        chain.unshift({
          statement: 'An inventory config change came first.',
          ledgerEntryIds: [herring],
          onsetEntryId: herring,
        });
        const recs = input['recommendations'] as { patch: unknown; addresses: string }[];
        recs.push({ ...(recs[0] as object), patch: { revert: 'ev_1' }, addresses: 'cause' } as {
          patch: unknown;
          addresses: string;
        });
      }),
    );
    expect(r.redHerrings).toEqual({
      notBlamed: false,
      blamed: [expect.stringContaining('inventory config change ev_1')],
    });
    expect(r.pass).toBe(false);
  }, 120_000);

  it('catches a root cause of the wrong kind', async () => {
    const r = await run(
      diagnosisWith((input, request) => {
        const board = JSON.parse(
          String(
            (
              request.messages.flatMap((m) =>
                typeof m.content === 'string' ? [] : (m.content ?? []),
              ) as { type: string; content?: unknown }[]
            )
              .filter((b) => b.type === 'tool_result')
              .map((b) => b.content)
              .find((c) => typeof c === 'string' && c.includes('"tested"')) ?? '{}',
          ),
        ) as { tested?: { id: string; kind: string }[] };
        const slow = board.tested?.find((h) => h.kind === 'db_slow')?.id ?? '';
        (input['rootCause'] as { hypothesisId: string }).hypothesisId = slow;
        input['rejectedHypotheses'] = (
          input['rejectedHypotheses'] as { hypothesisId: string }[]
        ).filter((h) => h.hypothesisId !== slow);
      }),
    );
    expect(r.rootCause.got).toBe('db_slow');
    expect(r.rootCause.match).toBe(false);
    expect(r.pass).toBe(false);
  }, 120_000);

  it('counts a number the facts do not contain, published after the revision rounds, as a hallucination', async () => {
    const r = await run(
      diagnosisWith((input) => {
        (input['rootCause'] as { statement: string }).statement += ' It lasted 98765 ms.';
      }),
    );
    expect(r.hallucinations).toBe(1);
    expect(r.caughtInRevision).toBe(2);
    expect(r.pass).toBe(false);
  }, 120_000);

  it('reports an investigation that fails as a failed row, not a crash', async () => {
    const r = await run(() => [{ name: 'propose_hypotheses', input: { hypotheses: [] } }]);
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/could not produce a valid set of hypotheses/);
    expect(r.pass).toBe(false);
    expect(resultsTable([r])).toMatch(/\| \*\*failed\*\*: .*\| \*\*fail\*\* \|$/m);
  }, 120_000);
});

/** A table row's cells, without the padding Prettier adds. */
const cells = (line: string): string =>
  line
    .split('|')
    .map((c) => c.trim())
    .join('|');

describe('the README eval table', () => {
  it('is what the harness produces now (run `tracepilot eval --write-readme` after changes)', async () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const start = readme.indexOf('<!-- eval:start');
    const end = readme.indexOf('<!-- eval:end -->');
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(readme.indexOf('\n', start) + 1, end).trim();
    const rows = section
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| Scenario'));
    // Every scripted row in the README is reproduced by running the harness again.
    const scenarios = [
      ...new Set(
        rows
          .map((l) => /^\| ([\w-]+) \(seed (\d+)\)/.exec(l))
          .filter((m) => m !== null)
          .map((m) => `${m[1] ?? ''}:${m[2] ?? ''}`),
      ),
    ];
    expect(scenarios.length).toBeGreaterThan(0);
    for (const key of scenarios) {
      const [scenario = '', seed = ''] = key.split(':');
      const r = await evaluateScenario({ scenario, seed: Number(seed), investigator: 'scripted' });
      const line = resultsTable([r]).split('\n')[2] ?? '';
      expect(rows.map(cells), key).toContain(cells(line));
    }
  }, 600_000);
});
