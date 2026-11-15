import { createHash } from 'node:crypto';
import type { Telemetry } from './engine.ts';

/** SHA-256 over the telemetry, in emission order. Equal hash ⇔ byte-identical telemetry. */
export function hashTelemetry(t: Telemetry): string {
  const h = createHash('sha256');
  for (const key of ['spans', 'logs', 'metrics', 'changeEvents', 'podEvents'] as const) {
    h.update(`#${key}\n`);
    for (const item of t[key]) {
      h.update(JSON.stringify(item));
      h.update('\n');
    }
  }
  return h.digest('hex');
}
