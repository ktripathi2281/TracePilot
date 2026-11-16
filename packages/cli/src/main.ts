// The `tracepilot` command (brief §9): `sim run` and `investigate`. The other commands arrive
// with their phases and say so instead of pretending.
//
// Data layout under --out (default .data):
//   telemetry.db            the telemetry store. Telemetry only, incidents under neutral IDs.
//                           This is what the investigator can reach (through store queries).
//   sim/<incidentId>.json   PRIVATE: scenario name, seed and the full recording (system model +
//                           workload) needed to replay. Read only by the simulator side (replay,
//                           eval). The store has no API that reads it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Recording,
  SCENARIOS,
  findTelemetryProblems,
  hashTelemetry,
  recordScenario,
  runSimulation,
} from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { z } from 'zod';
import { investigateCommand, type InvestigateDeps } from './investigate.ts';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `tracepilot <command>

  sim run --scenario <name> [--seed <n>] [--out <dir>]   simulate a scenario and ingest its telemetry
  investigate --incident <id> [--stream] [--out <dir>]   investigate an incident and print the diagnosis

Environment for investigate:
  TRACEPILOT_LLM=live|record|replay   live (default) calls the API; record also saves a cassette;
                                      replay uses only the cassette
  TRACEPILOT_MODEL, TRACEPILOT_VERIFIER_MODEL, TRACEPILOT_EFFORT, MAX_TOKENS_PER_INVESTIGATION,
  TRACEPILOT_CASSETTE_DIR (default <out>/cassettes); credentials via ANTHROPIC_API_KEY

Scenarios: ${Object.keys(SCENARIOS).join(', ')}

Not implemented yet:
  replay / sweep (Phase 4), eval (Phase 6)`;

const LATER: Readonly<Record<string, string>> = {
  replay: 'Phase 4',
  sweep: 'Phase 4',
  eval: 'Phase 6',
};

export const STORE_FILE = 'telemetry.db';
export const SIM_DIR = 'sim';

/** The private, simulator-side record of a simulated incident. */
export const SimRecordingFile = z.strictObject({
  formatVersion: z.literal(1),
  incidentId: z.string(),
  scenario: z.string(),
  seed: z.number().int().nonnegative(),
  /** Must equal the store's telemetry hash for the incident; replays are checked against it. */
  telemetryHash: z.string(),
  recording: Recording,
});
export type SimRecordingFile = z.infer<typeof SimRecordingFile>;

export const simRecordingPath = (outDir: string, incidentId: string): string =>
  join(outDir, SIM_DIR, `${incidentId}.json`);

export function readSimRecording(outDir: string, incidentId: string): SimRecordingFile {
  return SimRecordingFile.parse(
    JSON.parse(readFileSync(simRecordingPath(outDir, incidentId), 'utf8')),
  );
}

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
  // Same validation an ingestor would apply (brief §2). Never store telemetry that fails it.
  const problems = findTelemetryProblems(telemetry);
  if (problems.length > 0) {
    io.err(`sim run: generated telemetry is invalid:\n- ${problems.join('\n- ')}`);
    return 1;
  }

  mkdirSync(join(values.out, SIM_DIR), { recursive: true });
  const storePath = join(values.out, STORE_FILE);
  const store = new TelemetryStore(storePath);
  let result;
  try {
    result = store.ingest(telemetry, { source: 'synthetic' });
  } finally {
    store.close();
  }
  const { incident, created } = result;
  const telemetryHash = hashTelemetry(telemetry);
  if (telemetryHash !== incident.telemetryHash) {
    io.err('sim run: the store hashed the telemetry differently than the simulator');
    return 1;
  }
  const file: SimRecordingFile = {
    formatVersion: 1,
    incidentId: incident.id,
    scenario: values.scenario,
    seed,
    telemetryHash,
    recording,
  };
  writeFileSync(simRecordingPath(values.out, incident.id), JSON.stringify(file));

  const c = incident.counts;
  io.out(`incident   ${incident.id}${created ? '' : ' (already in the store)'}`);
  io.out(
    `telemetry  ${String(c.spans)} spans, ${String(c.logs)} logs, ${String(c.metrics)} metric points, ${String(c.changeEvents)} change events`,
  );
  io.out(`hash       ${telemetryHash}`);
  io.out(`store      ${storePath}`);
  io.out(`recording  ${simRecordingPath(values.out, incident.id)} (simulator side only)`);
  return 0;
}

/** Runs the CLI. Returns the process exit code. */
export async function main(argv: string[], io: Io, deps: InvestigateDeps = {}): Promise<number> {
  const [command, sub, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }
  if (command === 'sim' && sub === 'run') return simRun(rest, io);
  if (command === 'investigate') return investigateCommand(argv.slice(1), io, deps);
  const later = LATER[command];
  if (later !== undefined) {
    io.err(`"${command}" is not implemented yet (${later}).`);
    return 2;
  }
  io.err(`unknown command: ${argv.join(' ')}\n\n${USAGE}`);
  return 2;
}
