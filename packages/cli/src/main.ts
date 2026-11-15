// The `tracepilot` command (brief §9). Phase 1 implements `sim run`; the other commands arrive
// with their phases and say so instead of pretending.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  SCENARIOS,
  findTelemetryProblems,
  hashTelemetry,
  recordScenario,
  runSimulation,
} from '@tracepilot/sim';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `tracepilot <command>

  sim run --scenario <name> [--seed <n>] [--out <dir>]   generate telemetry for a scenario

Scenarios: ${Object.keys(SCENARIOS).join(', ')}

Not implemented yet:
  investigate (Phase 3), replay / sweep (Phase 4), eval (Phase 6)`;

const LATER: Readonly<Record<string, string>> = {
  investigate: 'Phase 3',
  replay: 'Phase 4',
  sweep: 'Phase 4',
  eval: 'Phase 6',
};

export interface SimRunManifest {
  scenario: string;
  seed: number;
  durationUs: number;
  /** SHA-256 of the telemetry. Re-running recording.json must reproduce it exactly. */
  telemetryHash: string;
  counts: {
    requests: number;
    spans: number;
    logs: number;
    metrics: number;
    changeEvents: number;
    podEvents: number;
  };
  files: string[];
}

const jsonl = (items: readonly unknown[]): string =>
  items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '');

function simRun(args: string[], io: Io): number {
  const { values } = parseArgs({
    args,
    options: {
      scenario: { type: 'string' },
      seed: { type: 'string', default: '42' },
      out: { type: 'string', default: '.data' },
    },
  });
  if (values.scenario === undefined) {
    io.err('sim run: --scenario is required');
    return 2;
  }
  if (!/^\d+$/.test(values.seed)) {
    io.err(`sim run: --seed must be a non-negative integer, got "${values.seed}"`);
    return 2;
  }
  const seed = Number(values.seed);
  if (SCENARIOS[values.scenario] === undefined) {
    io.err(
      `sim run: unknown scenario "${values.scenario}". Available: ${Object.keys(SCENARIOS).join(', ')}`,
    );
    return 2;
  }

  const recording = recordScenario(values.scenario, seed);
  const { telemetry } = runSimulation(recording.config, recording.workload);
  // Same validation an ingestor would apply (brief §2). Never write telemetry that fails it.
  const problems = findTelemetryProblems(telemetry);
  if (problems.length > 0) {
    io.err(`sim run: generated telemetry is invalid:\n- ${problems.join('\n- ')}`);
    return 1;
  }

  const dir = join(values.out, `${values.scenario}-seed${String(seed)}`);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    'recording.json': JSON.stringify(recording),
    'spans.jsonl': jsonl(telemetry.spans),
    'logs.jsonl': jsonl(telemetry.logs),
    'metrics.jsonl': jsonl(telemetry.metrics),
    'change-events.jsonl': jsonl(telemetry.changeEvents),
    'pod-events.jsonl': jsonl(telemetry.podEvents),
  };
  const manifest: SimRunManifest = {
    scenario: values.scenario,
    seed,
    durationUs: recording.config.durationUs,
    telemetryHash: hashTelemetry(telemetry),
    counts: {
      requests: recording.workload.requests.length,
      spans: telemetry.spans.length,
      logs: telemetry.logs.length,
      metrics: telemetry.metrics.length,
      changeEvents: telemetry.changeEvents.length,
      podEvents: telemetry.podEvents.length,
    },
    files: Object.keys(files),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const c = manifest.counts;
  io.out(
    `scenario   ${manifest.scenario} (seed ${String(seed)}, ${String(manifest.durationUs / 60_000_000)} min virtual time)`,
  );
  io.out(`workload   ${String(c.requests)} requests`);
  io.out(
    `telemetry  ${String(c.spans)} spans, ${String(c.logs)} logs, ${String(c.metrics)} metric points, ${String(c.changeEvents)} change events`,
  );
  io.out(`hash       ${manifest.telemetryHash}`);
  io.out(`written to ${dir}`);
  return 0;
}

/** Runs the CLI. Returns the process exit code. */
export function main(argv: string[], io: Io): number {
  const [command, sub, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }
  if (command === 'sim' && sub === 'run') return simRun(rest, io);
  const later = LATER[command];
  if (later !== undefined) {
    io.err(`"${command}" is not implemented yet (${later}).`);
    return 2;
  }
  io.err(`unknown command: ${argv.join(' ')}\n\n${USAGE}`);
  return 2;
}
