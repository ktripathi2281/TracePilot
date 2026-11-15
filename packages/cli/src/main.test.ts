import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogRecord, MetricPoint, Span } from '@tracepilot/schema';
import { Recording, hashTelemetry, runSimulation } from '@tracepilot/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, type SimRunManifest } from './main.ts';

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe('tracepilot sim run', () => {
  let dir: string;
  let runDir: string;
  let stdout: string[];
  let code: number;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracepilot-cli-'));
    const c = capture();
    code = main(
      ['sim', 'run', '--scenario', 'pool-exhaustion', '--seed', '42', '--out', dir],
      c.io,
    );
    stdout = c.out;
    runDir = join(dir, 'pool-exhaustion-seed42');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const read = (name: string): string => readFileSync(join(runDir, name), 'utf8');
  const lines = (name: string): unknown[] =>
    read(name)
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as unknown);

  it('writes schema-valid telemetry files and a manifest', () => {
    expect(code).toBe(0);
    const manifest = JSON.parse(read('manifest.json')) as SimRunManifest;
    expect(manifest.scenario).toBe('pool-exhaustion');
    expect(manifest.seed).toBe(42);
    const spans = lines('spans.jsonl');
    expect(spans).toHaveLength(manifest.counts.spans);
    expect(lines('logs.jsonl')).toHaveLength(manifest.counts.logs);
    expect(lines('metrics.jsonl')).toHaveLength(manifest.counts.metrics);
    expect(lines('change-events.jsonl')).toHaveLength(2);
    expect(lines('pod-events.jsonl')).toHaveLength(0);
    expect(spans.slice(0, 200).every((s) => Span.safeParse(s).success)).toBe(true);
    expect(
      lines('logs.jsonl')
        .slice(0, 200)
        .every((l) => LogRecord.safeParse(l).success),
    ).toBe(true);
    expect(
      lines('metrics.jsonl')
        .slice(0, 200)
        .every((m) => MetricPoint.safeParse(m).success),
    ).toBe(true);
    expect(stdout.join('\n')).toContain(manifest.telemetryHash);
  });

  it('identity replay from disk: recording.json reproduces the written telemetry exactly', () => {
    const manifest = JSON.parse(read('manifest.json')) as SimRunManifest;
    const recording = Recording.parse(JSON.parse(read('recording.json')));
    const replay = runSimulation(recording.config, recording.workload);
    expect(hashTelemetry(replay.telemetry)).toBe(manifest.telemetryHash);
    expect(replay.telemetry.spans).toEqual(lines('spans.jsonl'));
    expect(replay.telemetry.metrics).toEqual(lines('metrics.jsonl'));
    expect(replay.telemetry.logs).toEqual(lines('logs.jsonl'));
  });

  it('does not leak the incident ground truth into its output', () => {
    expect(stdout.join('\n')).not.toMatch(/root cause|red herring|hold-and-wait|deadlock/i);
  });
});

describe('tracepilot argument handling', () => {
  it('prints usage', () => {
    const c = capture();
    expect(main([], c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('sim run --scenario');
  });

  it('rejects bad input with exit code 2', () => {
    for (const argv of [
      ['sim', 'run'],
      ['sim', 'run', '--scenario', 'nope'],
      ['sim', 'run', '--scenario', 'pool-exhaustion', '--seed', 'abc'],
      ['frobnicate'],
    ]) {
      const c = capture();
      expect(main(argv, c.io), argv.join(' ')).toBe(2);
      expect(c.err.length).toBeGreaterThan(0);
    }
  });

  it('says which phase brings the commands that do not exist yet', () => {
    const c = capture();
    expect(main(['replay', '--incident', 'x'], c.io)).toBe(2);
    expect(c.err.join('\n')).toMatch(/not implemented yet \(Phase 4\)/);
  });
});
