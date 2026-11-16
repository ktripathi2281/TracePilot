// `tracepilot replay` and `tracepilot sweep` through the CLI, on scenario A in a temp directory.
// The diagnosis file is the one `tracepilot investigate` writes when a scripted test double plays
// the model (no API calls).

import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedLlm, protocolScript } from '@tracepilot/agents/testing';
import { REPLAY_NOTICE, ReplayRun, Sweep } from '@tracepilot/replay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { investigationPath } from './investigate.ts';
import { main, simRecordingPath } from './main.ts';
import { replayPath } from './replay.ts';

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

let dir: string;
let incidentId: string;
const tool = async (...argv: string[]) => {
  const c = capture();
  const code = await main([...argv, '--out', dir], c.io);
  return { code, out: c.out.join('\n'), err: c.err.join('\n'), lines: c.out };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tracepilot-replay-'));
  const sim = capture();
  await main(['sim', 'run', '--scenario', 'pool-exhaustion', '--seed', '42', '--out', dir], sim.io);
  incidentId = /^incident\s+(in_[0-9a-z]+)/.exec(sim.out[0] ?? '')?.[1] ?? '';
  const inv = capture();
  const code = await main(['investigate', '--incident', incidentId, '--out', dir], inv.io, {
    llm: new ScriptedLlm(protocolScript()),
    env: {},
  });
  expect(code).toBe(0);
}, 300_000);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tracepilot replay', () => {
  it('replays a patch and prints simulator-computed deltas between two notices', async () => {
    const r = await tool('replay', '--incident', incidentId, '--patch', 'db.pool.capacity=64');
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(REPLAY_NOTICE);
    expect(r.lines.at(-1)).toBe(REPLAY_NOTICE);
    expect(r.out).toMatch(/identity replay exact: telemetry (\w{12}) = recorded \1/);
    expect(r.out).toMatch(
      /analysis windows \(inferred from the recorded telemetry, same for every run\): baseline T\+\d+:\d\d\.\d{3} – T\+\d+:\d\d\.\d{3}, incident T\+10:00\.000 – T\+15:00\.000/,
    );
    expect(r.out).toMatch(/requests failed +\d+ +0 +−\d+ \(better\)/);
    expect(r.out).toMatch(/! db\.executor became a bottleneck: saturated/);
    expect(r.out).toMatch(/✓ db\.pool is no longer a bottleneck/);
    const saved = /saved {2}(.+)$/m.exec(r.out)?.[1] ?? '';
    const run = ReplayRun.parse(JSON.parse(readFileSync(saved, 'utf8')));
    expect(run.patches).toEqual([{ target: 'db.pool.capacity', to: 64 }]);
    expect(run.notice).toBe(REPLAY_NOTICE);
    expect(saved).toBe(replayPath(dir, run.id));
  });

  it('reverts a change event and shows pinned knobs on the replayed change events', async () => {
    const revert = await tool('replay', '--incident', incidentId, '--revert', 'ev_2');
    expect(revert.code).toBe(0);
    expect(revert.out).toMatch(/VERDICT resolves/);
    expect(revert.out).toMatch(/reverted \(removed from the replay\): ev_2/);
    const pin = await tool('replay', '--incident', incidentId, '--patch', 'checkout.workers=20');
    expect(pin.out).toMatch(/pinned for the whole run: checkout\.workers/);
    expect(pin.out).toMatch(
      /ev_2 deploy checkout at T\+10:00\.000: workers pinned at 20 \(recorded diff 20 → 60 not applied\)/,
    );
  });

  it('replays a model variant', async () => {
    const r = await tool(
      'replay',
      '--incident',
      incidentId,
      '--variant',
      'release-connection-before-calls:checkout',
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/patches: release-connection-before-calls:checkout/);
    expect(r.out).toMatch(/VERDICT resolves/);
  });

  it('with no patch, is an identity replay that changes nothing', async () => {
    const r = await tool('replay', '--incident', incidentId);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/patches: \(none: identity replay\)/);
    expect(r.out).toMatch(/VERDICT no_change/);
  });

  it('replays every recommendation of a diagnosis file and compares cause with symptom', async () => {
    const file = investigationPath(dir, incidentId);
    const r = await tool('replay', '--incident', incidentId, '--diagnosis', file);
    expect(r.code).toBe(0);
    expect(r.lines[0]).not.toBe(REPLAY_NOTICE); // each run's block, then the comparison...
    expect(r.out).toMatch(/from rc_1 \[addresses cause\] "Revert the change"/);
    expect(r.out).toMatch(/from rc_2 \[addresses symptom\] "Enlarge the connection pool"/);
    expect(r.out).toMatch(/RECOMMENDATIONS REPLAYED ONE BY ONE/);
    expect(r.out).toMatch(/rc_1 +cause +revert ev_2 +resolves +0\.0%/);
    expect(r.out).toMatch(
      /rc_2 +symptom +db\.pool\.capacity=64 +(resolves|improves) +0\.0% .*db\.executor/,
    );
    expect(r.out).toMatch(/rc_2 treats the symptom and rc_1 the cause/);
    expect(
      r.out.match(new RegExp(REPLAY_NOTICE.replace(/\./g, '\\.'), 'g'))?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(r.lines.at(-1)).toBe(REPLAY_NOTICE);

    const one = await tool(
      'replay',
      '--incident',
      incidentId,
      '--diagnosis',
      file,
      '--recommendation',
      'rc_2',
    );
    expect(one.out).not.toMatch(/from rc_1/);
    expect(one.out).toMatch(/from rc_2/);
  });

  it('prints the result as JSON on request', async () => {
    const r = await tool('replay', '--incident', incidentId, '--revert', 'ev_2', '--json');
    expect(r.code).toBe(0);
    expect(ReplayRun.parse(JSON.parse(r.out)).verdict).toBe('resolves');
  });

  it('rejects bad input with exit code 64', async () => {
    const file = investigationPath(dir, incidentId);
    const cases: [string[], RegExp][] = [
      [['replay'], /--incident is required/],
      [['replay', '--incident', 'in_nope'], /no incident in_nope/],
      [
        ['replay', '--incident', incidentId, '--patch', 'db.pool.capacity=lots'],
        /non-negative integer/,
      ],
      [
        ['replay', '--incident', incidentId, '--patch', 'db.pool.size=64'],
        /unsupported patch target/,
      ],
      [['replay', '--incident', incidentId, '--patch', 'cache.capacity=10'], /no cache is modeled/],
      [['replay', '--incident', incidentId, '--revert', 'ev_99'], /cannot revert ev_99/],
      [['replay', '--incident', incidentId, '--patch', 'db.pool.capacity=0'], /must be >= 1/],
      [['replay', '--incident', incidentId, '--variant', 'make-it-fast:checkout'], /./],
      [['replay', '--incident', incidentId, '--diagnosis', file, '--revert', 'ev_2'], /not both/],
      [['replay', '--incident', incidentId, '--recommendation', 'rc_1'], /needs --diagnosis/],
      [
        ['replay', '--incident', incidentId, '--diagnosis', file, '--recommendation', 'rc_9'],
        /no recommendation rc_9/,
      ],
      [['sweep', '--incident', incidentId, '--param', 'db.pool.capacity'], /--range is required/],
      [
        ['sweep', '--incident', incidentId, '--param', 'db.pool.size', '--range', '1:2:1'],
        /unsupported --param/,
      ],
      [
        ['sweep', '--incident', incidentId, '--param', 'db.pool.capacity', '--range', '20-120'],
        /<from>:<to>:<step>/,
      ],
    ];
    for (const [argv, message] of cases) {
      const r = await tool(...argv);
      expect(r.code, argv.join(' ')).toBe(64);
      expect(r.err, argv.join(' ')).toMatch(message);
    }
  });

  it('needs the simulator recording, and says so', async () => {
    const path = simRecordingPath(dir, incidentId);
    const saved = readFileSync(path);
    unlinkSync(path);
    try {
      const r = await tool('replay', '--incident', incidentId, '--revert', 'ev_2');
      expect(r.code).toBe(64);
      expect(r.err).toMatch(
        /no simulator recording for in_\w+ .*Replay works only on incidents produced by `sim run`/,
      );
    } finally {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, saved);
    }
    expect(existsSync(path)).toBe(true);
  });
});

describe('tracepilot sweep', () => {
  it('replays a range of one knob and reports the knee and the bottleneck shift', async () => {
    const r = await tool(
      'sweep',
      '--incident',
      incidentId,
      '--param',
      'db.pool.capacity',
      '--range',
      '40:80:10',
    );
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(REPLAY_NOTICE);
    expect(r.lines.at(-1)).toBe(REPLAY_NOTICE);
    expect(r.out).toMatch(/SWEEP db\.pool\.capacity on in_\w+/);
    expect(r.out).toMatch(/analysis windows .*incident T\+10:00\.000 – T\+15:00\.000/);
    expect(r.out).toMatch(/^ +60 +resolves +0\.0%/m);
    expect(r.out).toMatch(/KNEE 60: /);
    expect(r.out).toMatch(/BOTTLENECK SHIFT from \d+: db\.executor under pressure/);
    const saved = /saved {2}(.+)$/m.exec(r.out)?.[1] ?? '';
    const sweep = Sweep.parse(JSON.parse(readFileSync(saved, 'utf8')));
    expect(sweep.points.map((p) => p.value)).toEqual([40, 50, 60, 70, 80]);
    expect(sweep.notice).toBe(REPLAY_NOTICE);
  });
});
