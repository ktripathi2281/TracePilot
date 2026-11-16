// `tracepilot investigate`, end to end through the CLI, with a scripted test double in place of
// the model (deps.llm). This checks the command's plumbing: store in, record out, exit codes,
// what is printed. It says nothing about a real model's diagnosis (that is Gate 3, eval/).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Investigation } from '@tracepilot/agents';
import { ScriptedLlm, protocolScript } from '@tracepilot/agents/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { investigationPath, llmLogPath } from './investigate.ts';
import { main } from './main.ts';

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe('tracepilot investigate', () => {
  let dir: string;
  let incidentId: string;
  let code: number;
  let out: string;
  let llm: ScriptedLlm;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tracepilot-investigate-'));
    const sim = capture();
    await main(
      ['sim', 'run', '--scenario', 'pool-exhaustion', '--seed', '42', '--out', dir],
      sim.io,
    );
    incidentId = /^incident\s+(in_[0-9a-z]+)/.exec(sim.out[0] ?? '')?.[1] ?? '';
    const c = capture();
    llm = new ScriptedLlm(protocolScript());
    code = await main(['investigate', '--incident', incidentId, '--out', dir, '--stream'], c.io, {
      llm,
      env: {},
    });
    out = c.out.join('\n');
    expect(c.err).toEqual([]);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the diagnosis with its evidence and exits 0', () => {
    expect(code).toBe(0);
    expect(out).toMatch(/ROOT CAUSE \(hold_and_wait, hypothesis hy_\w+\)/);
    expect(out).toMatch(/CONFIDENCE high \(1\): 3 predictions supported, 0 contradicted/);
    expect(out).toMatch(/CAUSAL CHAIN\n {2}1\. \[T\+10:00\.000\] /);
    expect(out).toMatch(/REJECTED HYPOTHESES\n {2}✗ Pool too small for demand/);
    expect(out).toMatch(/✗ Database is slow/);
    expect(out).toMatch(/rc_1 \[addresses cause\] .* patch: revert ev_2/);
    expect(out).toMatch(/rc_2 \[addresses symptom\] .* patch: db\.pool\.capacity/);
    expect(out).toMatch(/follow-up: Do not hold a connection across downstream calls/);
    expect(out).toMatch(/SKEPTIC \(3 new queries\)/);
    expect(out).toMatch(/VERIFIER {2}1 round\(s\), 0 revision\(s\); last round: passed/);
    // Cited ledger entries are printed with the statement the tools produced.
    expect(out).toMatch(/ {4}le_\w+ {2}Hold-and-wait in the incident window: DETECTED/);
  });

  it('labels a run that did not come from a model', () => {
    expect(out).toContain('[Scripted test double: not a model run]');
    expect(out).not.toContain('Recorded run');
  });

  it('streams progress when asked', () => {
    expect(out).toMatch(/── investigating\n/);
    expect(out).toMatch(/investigator ✓ get_incident_window → /);
    expect(out).toMatch(/── testing hypotheses/);
    expect(out).toMatch(
      /▶ hy_1 \[supported\] Connection hold-and-wait starvation \(hold_and_wait\): 3 supported/,
    );
    expect(out).toMatch(/── skeptic: Connection hold-and-wait starvation/);
    expect(out).toMatch(/verifier {5}round 0: passed/);
  });

  it('saves the full record and a log of the LLM calls', () => {
    const path = investigationPath(dir, incidentId);
    expect(out).toContain(`saved  ${path}`);
    const saved = Investigation.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(saved).toMatchObject({ incidentId, outcome: 'diagnosed', llm: { mode: 'scripted' } });
    expect(saved.ledger.length).toBeGreaterThan(50);
    const log = readFileSync(llmLogPath(dir, incidentId), 'utf8').trim().split('\n');
    expect(log).toHaveLength(llm.requests.length);
    expect(JSON.parse(log[0] ?? '{}')).toMatchObject({ call: 1, request: { messages: 1 } });
  });

  it('reads the incident through the store only: ground truth never reaches the model', () => {
    const sent = JSON.stringify(llm.requests);
    expect(sent).not.toMatch(
      /pool-exhaustion|whyNotCausal|discriminatingEvidence|rejectedAlternatives/i,
    );
    expect(sent).not.toContain('"seed"');
  });

  it('prints nothing but the diagnosis without --stream', async () => {
    const c = capture();
    const exit = await main(['investigate', '--incident', incidentId, '--out', dir], c.io, {
      llm: new ScriptedLlm(protocolScript()),
      env: {},
    });
    expect(exit).toBe(0);
    expect(c.out[0]).toMatch(/^Incident in_\w+ {3}model claude-sonnet-5-5 {3}mode scripted/);
    expect(c.out.join('\n')).not.toMatch(/── investigating/);
  });

  it('exits 1 and says so when no diagnosis can be published', async () => {
    const c = capture();
    const exit = await main(['investigate', '--incident', incidentId, '--out', dir], c.io, {
      llm: new ScriptedLlm(() => 'I would rather not call tools.'),
      env: {},
    });
    expect(exit).toBe(1);
    expect(c.out.join('\n')).toContain('No diagnosis could be published.');
    expect(c.out.join('\n')).toContain(
      'note: The investigator stopped before a diagnosis was verified.',
    );
  });

  it('exits 2 when the diagnosis is published with unresolved verifier issues', async () => {
    const base = protocolScript();
    const c = capture();
    const exit = await main(['investigate', '--incident', incidentId, '--out', dir], c.io, {
      // Every draft carries a number no fact contains, so it never passes the verifier.
      llm: new ScriptedLlm((request) => {
        const out = base(request);
        if (typeof out === 'string') return out;
        return out.map((call) => {
          if (call.name !== 'submit_diagnosis') return call;
          const input = structuredClone(call.input) as { rootCause: { statement: string } };
          input.rootCause.statement += ' It lasted 98765 ms.';
          return { name: call.name, input };
        });
      }),
      env: {},
    });
    expect(exit).toBe(2);
    expect(c.out.join('\n')).toMatch(
      /UNRESOLVED VERIFIER ISSUES \(published after 2 revision rounds\)/,
    );
    expect(c.err.join('\n')).toMatch(
      /published with 1 unresolved verifier issue\(s\); it is not verified/,
    );
  });

  it('stops with exit 1 when the token budget is exceeded', async () => {
    const c = capture();
    const exit = await main(['investigate', '--incident', incidentId, '--out', dir], c.io, {
      llm: new ScriptedLlm(protocolScript()),
      env: { MAX_TOKENS_PER_INVESTIGATION: '3000' },
    });
    expect(exit).toBe(1);
    expect(c.err.join('\n')).toMatch(/investigate: .*budget/i);
  });

  it('replay without a cassette fails with instructions, and never calls the API', async () => {
    const c = capture();
    const exit = await main(['investigate', '--incident', incidentId, '--out', dir], c.io, {
      env: { TRACEPILOT_LLM: 'replay' },
    });
    expect(exit).toBe(1);
    expect(c.err.join('\n')).toMatch(
      /no cassette at .*cassettes.*Record one with TRACEPILOT_LLM=record/,
    );
    expect(existsSync(join(dir, 'cassettes'))).toBe(false);
  });

  it('rejects bad input with exit code 2', async () => {
    const cases: [string[], Record<string, string>, RegExp][] = [
      [['investigate'], {}, /--incident is required/],
      [['investigate', '--incident', 'in_nope', '--out', dir], {}, /no incident in_nope/],
      [
        ['investigate', '--incident', incidentId, '--out', dir],
        { TRACEPILOT_LLM: 'offline' },
        /live, record or replay/,
      ],
      [
        ['investigate', '--incident', incidentId, '--out', dir],
        { MAX_TOKENS_PER_INVESTIGATION: '-5' },
        /positive integer/,
      ],
    ];
    for (const [argv, env, message] of cases) {
      const c = capture();
      expect(await main(argv, c.io, { env }), argv.join(' ')).toBe(2);
      expect(c.err.join('\n')).toMatch(message);
    }
  });
});
