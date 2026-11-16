import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashTelemetry, runSimulation } from '@tracepilot/sim';
import { TelemetryStore, hashBundle } from '@tracepilot/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE_FILE, main, readSimRecording } from './main.ts';

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe('tracepilot sim run', () => {
  let dir: string;
  let stdout: string[];
  let code: number;
  let incidentId: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tracepilot-cli-'));
    const c = capture();
    code = await main(
      ['sim', 'run', '--scenario', 'pool-exhaustion', '--seed', '42', '--out', dir],
      c.io,
    );
    stdout = c.out;
    incidentId = /^incident\s+(in_[0-9a-z]+)/.exec(stdout[0] ?? '')?.[1] ?? '';
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingests the telemetry into the store under a neutral incident ID', async () => {
    expect(code).toBe(0);
    expect(incidentId).toMatch(/^in_[0-9a-z]+$/);
    expect(incidentId).not.toMatch(/pool|exhaust|seed|42/);
    const store = new TelemetryStore(join(dir, STORE_FILE));
    try {
      const incident = store.getIncident(incidentId);
      expect(incident.counts.spans).toBeGreaterThan(20_000);
      expect(incident.counts.changeEvents).toBe(2);
      expect(store.listIncidents().map((i) => i.id)).toEqual([incidentId]);
      expect(stdout.join('\n')).toContain(incident.telemetryHash);
    } finally {
      store.close();
    }
    // Only the store and the simulator-side directory: no telemetry dumps next to them.
    expect(
      readdirSync(dir)
        .filter((f) => !f.startsWith(`${STORE_FILE}-`))
        .sort(),
    ).toEqual(['sim', STORE_FILE]);
  });

  it('identity replay: the private recording reproduces the stored telemetry exactly', async () => {
    const file = readSimRecording(dir, incidentId);
    expect(file.incidentId).toBe(incidentId);
    expect(file.scenario).toBe('pool-exhaustion');
    const replay = runSimulation(file.recording.config, file.recording.workload);
    const store = new TelemetryStore(join(dir, STORE_FILE));
    try {
      const stored = store.exportTelemetry(incidentId);
      expect(hashTelemetry(replay.telemetry)).toBe(file.telemetryHash);
      expect(hashBundle(stored)).toBe(file.telemetryHash);
      expect(stored.spans).toEqual(replay.telemetry.spans);
      expect(stored.metrics).toEqual(replay.telemetry.metrics);
      expect(stored.logs).toEqual(replay.telemetry.logs);
    } finally {
      store.close();
    }
  });

  it('keeps simulator configuration and the scenario name out of the store file', async () => {
    // The raw database file (all pages) must not contain anything simulator-side.
    const bytes = readFileSync(join(dir, STORE_FILE)).toString('latin1');
    for (const secret of [
      'pool-exhaustion',
      'maxParallelQueries',
      'requestTypes',
      'disturbance',
      'scenario',
      'seed42',
    ]) {
      expect(bytes.includes(secret), secret).toBe(false);
    }
    // ...while the private recording does contain it (so the check above is meaningful).
    const recording = readFileSync(join(dir, 'sim', `${incidentId}.json`), 'utf8');
    expect(recording).toContain('maxParallelQueries');
  });

  it('re-running the same scenario and seed is idempotent', async () => {
    const c = capture();
    expect(
      await main(
        ['sim', 'run', '--scenario', 'pool-exhaustion', '--seed', '42', '--out', dir],
        c.io,
      ),
    ).toBe(0);
    expect(c.out[0]).toBe(`incident   ${incidentId} (already in the store)`);
  });

  it('does not print ground truth', async () => {
    expect(stdout.join('\n')).not.toMatch(/root cause|red herring|hold-and-wait|deadlock/i);
  });
});

describe('tracepilot argument handling', () => {
  it('prints usage', async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('sim run --scenario');
  });

  it('rejects bad input with exit code 64', async () => {
    for (const argv of [
      ['sim', 'run'],
      ['sim', 'run', '--scenario', 'nope'],
      ['sim', 'run', '--scenario', 'pool-exhaustion', '--seed', 'abc'],
      ['frobnicate'],
    ]) {
      const c = capture();
      expect(await main(argv, c.io), argv.join(' ')).toBe(64);
      expect(c.err.length).toBeGreaterThan(0);
    }
  });

  it('says which phase brings the commands that do not exist yet', async () => {
    const c = capture();
    expect(await main(['eval', '--scenario', 'pool-exhaustion'], c.io)).toBe(64);
    expect(c.err.join('\n')).toMatch(/not implemented yet \(Phase 6\)/);
  });
});
