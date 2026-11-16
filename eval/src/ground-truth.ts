// Ground truth for the eval harness (brief §5, §10). One JSON file per scenario in
// eval/ground-truth/. Read only by eval: the agents, the store and the server cannot import it.

import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Fix = z.looseObject({ patch: z.unknown(), expected: z.string() });

export const GroundTruth = z.looseObject({
  scenario: z.string(),
  rootCause: z.looseObject({
    summary: z.string(),
    /** The change event that caused the incident. */
    changeEventId: z.string(),
    service: z.string(),
    /** Hypothesis kinds that name this root cause (the diagnosis's rootCause.kind must be one). */
    hypothesisKinds: z.array(z.string()).min(1),
  }),
  affectedServices: z.array(z.string()),
  redHerrings: z.array(
    z.looseObject({
      what: z.string(),
      kind: z.enum(['change', 'disturbance']),
      changeEventId: z.string().optional(),
      service: z.string().optional(),
      fromUs: z.number().optional(),
      toUs: z.number().optional(),
    }),
  ),
  fixes: z.looseObject({
    resolves: z.array(Fix),
    partial: z.array(Fix).default([]),
    worsens: z.array(Fix).default([]),
  }),
});
export type GroundTruth = z.infer<typeof GroundTruth>;

export function readGroundTruth(scenario: string): GroundTruth {
  const url = new URL(`../ground-truth/${scenario}.json`, import.meta.url);
  return GroundTruth.parse(JSON.parse(readFileSync(url, 'utf8')));
}
