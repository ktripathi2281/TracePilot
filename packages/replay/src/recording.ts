// The private, simulator-side record of a simulated incident (written by `tracepilot sim run`).
//
// It holds the system model and the recorded workload, which is everything a replay needs. It is
// never reachable from the telemetry store or the agents: only replay and eval read it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Recording } from '@tracepilot/sim';
import { z } from 'zod';

export const SIM_DIR = 'sim';

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
