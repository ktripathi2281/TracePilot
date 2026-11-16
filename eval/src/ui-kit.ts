// Helpers for the UI smoke tests: a data directory as `tracepilot sim run` writes it, the built
// web UI, and a real browser (the system's Edge or Chrome through playwright-core).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simRecordingPath, type SimRecordingFile } from '@tracepilot/replay';
import { hashTelemetry, recordScenario, runSimulation } from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { chromium, type Browser } from 'playwright-core';
import { build } from 'vite';

export const WEB_ROOT = fileURLToPath(new URL('../../apps/web', import.meta.url));

/** Simulates `scenario` into `dir` (store + private recording). Returns the incident ID. */
export function simulateInto(dir: string, scenario: string, seed = 42): string {
  const recording = recordScenario(scenario, seed);
  const { telemetry } = runSimulation(recording.config, recording.workload);
  const store = new TelemetryStore(join(dir, 'telemetry.db'));
  try {
    const { incident } = store.ingest(telemetry, { source: 'synthetic' });
    const file: SimRecordingFile = {
      formatVersion: 1,
      incidentId: incident.id,
      scenario,
      seed,
      telemetryHash: hashTelemetry(telemetry),
      recording,
    };
    mkdirSync(join(dir, 'sim'), { recursive: true });
    writeFileSync(simRecordingPath(dir, incident.id), JSON.stringify(file));
    return incident.id;
  } finally {
    store.close();
  }
}

/** Builds the web UI into `outDir`. */
export async function buildWeb(outDir: string): Promise<void> {
  await build({
    root: WEB_ROOT,
    configFile: join(WEB_ROOT, 'vite.config.ts'),
    logLevel: 'error',
    build: { outDir, emptyOutDir: true },
  });
}

/** Edge, then Chrome, or an explicit executable (TRACEPILOT_BROWSER). Fails loudly if none starts. */
export async function launchBrowser(): Promise<Browser> {
  const exe = process.env['TRACEPILOT_BROWSER'];
  if (exe !== undefined && exe !== '') return chromium.launch({ executablePath: exe });
  const problems: string[] = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel });
    } catch (e) {
      problems.push(
        `${channel}: ${e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)}`,
      );
    }
  }
  throw new Error(
    `no browser for the UI smoke test (set TRACEPILOT_BROWSER):\n${problems.join('\n')}`,
  );
}
