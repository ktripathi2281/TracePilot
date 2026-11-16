// Patches from a saved investigation (`tracepilot investigate` writes
// <out>/investigations/<incidentId>.json). Only the parts replay needs are read, and validated.

import { readFileSync } from 'node:fs';
import { Recommendation } from '@tracepilot/schema';
import { z } from 'zod';

const InvestigationFile = z.looseObject({
  incidentId: z.string(),
  outcome: z.string(),
  diagnosis: z
    .looseObject({
      recommendations: z.array(Recommendation),
      unresolvedIssues: z.array(z.unknown()),
    })
    .nullable(),
});

export class DiagnosisFileError extends Error {}

/**
 * The recommendations of the diagnosis in `path`, optionally only those with the given IDs.
 * Throws DiagnosisFileError when the file is for another incident or has no diagnosis.
 */
export function readRecommendations(
  path: string,
  incidentId: string,
  ids: readonly string[] = [],
): { recommendations: Recommendation[]; unresolvedIssues: number } {
  const parsed = InvestigationFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success)
    throw new DiagnosisFileError(`${path} is not an investigation record: ${parsed.error.message}`);
  const file = parsed.data;
  if (file.incidentId !== incidentId)
    throw new DiagnosisFileError(
      `${path} is the investigation of ${file.incidentId}, not of ${incidentId}`,
    );
  if (file.diagnosis === null)
    throw new DiagnosisFileError(`${path} has no diagnosis (outcome: ${file.outcome})`);
  const all = file.diagnosis.recommendations;
  const unknown = ids.filter((id) => !all.some((r) => r.id === id));
  if (unknown.length > 0)
    throw new DiagnosisFileError(
      `${path} has no recommendation ${unknown.join(', ')} (it has ${all.map((r) => r.id).join(', ')})`,
    );
  return {
    recommendations: ids.length === 0 ? all : all.filter((r) => ids.includes(r.id)),
    unresolvedIssues: file.diagnosis.unresolvedIssues.length,
  };
}
