// Deterministic verifier (brief §6). No LLM here.
//
// What it rejects, each with its own issue code:
//   missing_evidence       a cited evidence ID or ledger entry does not exist
//   value_mismatch         a FACT's quoted field differs from the store, or re-running the tool
//                          call does not reproduce the fact (value, numbers, statement, time)
//   ungrounded_number      a number in LLM-written text is not in the facts it cites
//   hypothesis_as_premise  a HYPOTHESIS entry is used as a premise or cited as support
//   temporal_precedence    a causal step certainly begins before the step preceding it, or has
//                          no dated fact
//   unsupported_logic      structural rules: the root cause must rest on the evidence that
//                          supported its hypothesis, rejections must match the engine's results,
//                          and so on
//
// FACTs are checked against a FRESH tool context, so this is an independent recomputation from
// the store, not a comparison of a cache with itself.

import {
  ChangeEventId,
  METRIC_UNITS,
  Patch,
  isRevertPatch,
  type FactEntry,
  type Hypothesis,
  type LedgerEntry,
  type VerifierIssue,
} from '@tracepilot/schema';
import type { Evidence, TelemetryStore } from '@tracepilot/store';
import { z } from 'zod';
import { anchorsOf, groundingOf, knobQuantity, ungroundedNumbers } from './grounding.ts';
import type { Ledger } from './ledger.ts';
import { ToolContext } from './tools/context.ts';
import { computeTool } from './tools/runner.ts';
import { callKey, type Finding } from './tools/types.ts';

const Ids = z.array(z.string().min(1)).min(1);

/** What an LLM role submits as a diagnosis. Confidence, IDs and kinds are added by the engine. */
export const DiagnosisDraft = z.strictObject({
  rootCause: z.strictObject({
    statement: z.string().min(1),
    hypothesisId: z.string().min(1),
    ledgerEntryIds: Ids,
  }),
  causalChain: z
    .array(
      z.strictObject({
        statement: z.string().min(1),
        service: z.string().min(1).optional(),
        ledgerEntryIds: Ids,
        onsetEntryId: z.string().min(1),
      }),
    )
    .min(2),
  affectedServices: z.array(z.string().min(1)).min(1),
  rejectedHypotheses: z.array(
    z.strictObject({
      hypothesisId: z.string().min(1),
      reason: z.string().min(1),
      ledgerEntryIds: Ids,
    }),
  ),
  unknowns: z.array(z.string().min(1)),
  recommendations: z
    .array(
      z.strictObject({
        title: z.string().min(1),
        rationale: z.string().min(1),
        patch: Patch,
        addresses: z.enum(['cause', 'symptom']),
        ledgerEntryIds: Ids,
      }),
    )
    .min(1),
  followUps: z.array(
    z.strictObject({ title: z.string().min(1), rationale: z.string().min(1), ledgerEntryIds: Ids }),
  ),
});
export type DiagnosisDraft = z.infer<typeof DiagnosisDraft>;

/** For recomputed quantities: equal up to floating-point noise. Quoted fields must match exactly. */
const close = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

/** Reads a quoted field from a stored evidence item; undefined if the item has no such field. */
export function readEvidenceField(e: Evidence, field: string): number | undefined {
  const num = (x: unknown): number | undefined => (typeof x === 'number' ? x : undefined);
  switch (e.kind) {
    case 'metric':
      return field === 'value' ? e.item.value : field === 'ts' ? e.item.ts : undefined;
    case 'span':
      if (field === 'startUs') return e.item.startUs;
      if (field === 'endUs') return e.item.endUs;
      if (field === 'durationUs') return e.item.endUs - e.item.startUs;
      if (field.startsWith('attributes.'))
        return num(e.item.attributes[field.slice('attributes.'.length)]);
      return undefined;
    case 'log':
      return field === 'ts'
        ? e.item.ts
        : field.startsWith('fields.')
          ? num(e.item.fields[field.slice('fields.'.length)])
          : undefined;
    case 'change': {
      if (field === 'ts') return e.item.ts;
      const m = /^diff\.(.+)\.(from|to)$/.exec(field);
      if (m === null) return undefined;
      const entry = e.item.diff[m[1] as string];
      return entry === undefined ? undefined : num(entry[m[2] as 'from' | 'to']);
    }
    case 'pod':
      return field === 'ts' ? e.item.ts : undefined;
  }
}

/**
 * The unit a quoted field of a stored telemetry item is in; undefined if the item has no such
 * field. Durations and timestamps are microseconds; metric values are in the metric's unit;
 * attributes, log fields and diff values named `..._us` / `...Us` are microseconds, others counts.
 */
export function readEvidenceUnit(e: Evidence, field: string): string | undefined {
  if (readEvidenceField(e, field) === undefined) return undefined;
  if (['ts', 'startUs', 'endUs', 'durationUs'].includes(field)) return 'us';
  if (e.kind === 'metric') return METRIC_UNITS[e.item.name];
  return /(_us|Us)(\.(from|to))?$/.test(field) ? 'us' : 'count';
}

const issue = (
  code: VerifierIssue['code'],
  location: string,
  message: string,
  ledgerEntryIds: string[] = [],
): VerifierIssue => ({
  code,
  location,
  message,
  ledgerEntryIds,
});

/** Checks every FACT against the store: evidence exists, quoted fields match, the finding is reproducible. */
export function verifyFacts(
  store: TelemetryStore,
  incidentId: string,
  facts: readonly FactEntry[],
): VerifierIssue[] {
  const issues: VerifierIssue[] = [];
  const ctx = new ToolContext(store, incidentId);
  const recomputed = new Map<string, Map<string, Finding> | string>();
  for (const f of facts) {
    const at = `ledger:${f.id}`;
    const found = new Map<string, Evidence>();
    for (const id of f.evidenceIds) {
      const ev = store.getEvidence(incidentId, id);
      if (ev === undefined)
        issues.push(
          issue('missing_evidence', at, `${f.id} cites ${id}, which is not in the store`, [f.id]),
        );
      else found.set(id, ev);
    }
    for (const q of f.quantities) {
      const ev = found.get(q.evidenceId);
      if (ev === undefined) continue; // already reported as missing
      const actual = readEvidenceField(ev, q.field);
      if (actual === undefined) {
        issues.push(
          issue(
            'value_mismatch',
            at,
            `${f.id} quotes ${q.evidenceId}.${q.field}, which that item does not have`,
            [f.id],
          ),
        );
      } else if (readEvidenceUnit(ev, q.field) !== q.unit) {
        issues.push(
          issue(
            'value_mismatch',
            at,
            `${f.id} quotes ${q.evidenceId}.${q.field} in unit "${q.unit}", but that field is in "${String(readEvidenceUnit(ev, q.field))}"`,
            [f.id],
          ),
        );
      } else if (actual !== q.value) {
        issues.push(
          issue(
            'value_mismatch',
            at,
            `${f.id} quotes ${q.evidenceId}.${q.field} = ${String(q.value)}, the store has ${String(actual)}`,
            [f.id],
          ),
        );
      }
    }
    const ck = callKey(f.tool, f.args);
    let findings = recomputed.get(ck);
    if (findings === undefined) {
      try {
        findings = new Map(computeTool(ctx, f.tool, f.args).findings.map((x) => [x.key, x]));
      } catch (e) {
        findings = e instanceof Error ? e.message : String(e);
      }
      recomputed.set(ck, findings);
    }
    if (typeof findings === 'string') {
      issues.push(
        issue('value_mismatch', at, `${f.id}: its tool call ${ck} cannot be re-run (${findings})`, [
          f.id,
        ]),
      );
      continue;
    }
    const again = findings.get(f.findingKey);
    if (again === undefined) {
      issues.push(
        issue(
          'value_mismatch',
          at,
          `${f.id}: re-running ${ck} does not produce finding "${f.findingKey}"`,
          [f.id],
        ),
      );
      continue;
    }
    const diffs: string[] = [];
    if (again.value !== f.value)
      diffs.push(`value ${JSON.stringify(f.value)} vs recomputed ${JSON.stringify(again.value)}`);
    if (again.statement !== f.statement) diffs.push('statement differs from the recomputed one');
    const derived = new Map(again.derived.map((x) => [x.name, x.value]));
    for (const q of f.derived) {
      const v = derived.get(q.name);
      if (v === undefined) diffs.push(`${q.name} is not among the recomputed quantities`);
      else if (!close(v, q.value))
        diffs.push(`${q.name} ${String(q.value)} vs recomputed ${String(v)}`);
    }
    const a = f.occurredAt;
    const b = again.occurredAt;
    if (
      (a === undefined) !== (b === undefined) ||
      (a !== undefined &&
        b !== undefined &&
        (a.tsUs !== b.tsUs || a.resolutionUs !== b.resolutionUs))
    ) {
      diffs.push('time differs from the recomputed one');
    }
    const unknownEvidence = f.evidenceIds.filter((id) => !again.evidenceIds.includes(id));
    if (unknownEvidence.length > 0)
      diffs.push(`cites ${unknownEvidence.join(', ')}, which the finding does not rest on`);
    if (diffs.length > 0)
      issues.push(
        issue('value_mismatch', at, `${f.id} is not reproduced by ${ck}: ${diffs.join('; ')}`, [
          f.id,
        ]),
      );
  }
  return issues;
}

/** Checks cited ledger IDs of one LLM-written statement: they exist, none is a HYPOTHESIS, numbers are grounded. */
export function checkClaim(
  ledger: Ledger,
  location: string,
  text: string,
  ids: readonly string[],
): VerifierIssue[] {
  const issues: VerifierIssue[] = [];
  const existing: string[] = [];
  for (const id of ids) {
    const e = ledger.get(id);
    if (e === undefined)
      issues.push(
        issue('missing_evidence', location, `cites ledger entry ${id}, which does not exist`),
      );
    else if (e.type === 'HYPOTHESIS') {
      issues.push(
        issue(
          'hypothesis_as_premise',
          location,
          `cites ${id}, a HYPOTHESIS, as support. Only FACT and INFERENCE entries can support a claim`,
          [id],
        ),
      );
    } else existing.push(id);
  }
  const bad = ungroundedNumbers(text, ledger.factsBehind(existing));
  if (bad.length > 0) {
    issues.push(
      issue(
        'ungrounded_number',
        location,
        `number(s) ${bad.join(', ')} do not appear in the facts this statement cites. Cite the fact that contains them or remove them`,
        existing,
      ),
    );
  }
  return issues;
}

/** INFERENCE entries: premises exist, are not hypotheses (directly or through other inferences), numbers grounded. */
export function verifyInferences(ledger: Ledger, entries: readonly LedgerEntry[]): VerifierIssue[] {
  const issues: VerifierIssue[] = [];
  const restsOnHypothesis = (id: string, seen: Set<string>): string | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const e = ledger.get(id);
    if (e === undefined) return null;
    if (e.type === 'HYPOTHESIS') return id;
    if (e.type === 'INFERENCE') {
      for (const p of e.premises) {
        const h = restsOnHypothesis(p, seen);
        if (h !== null) return h;
      }
    }
    return null;
  };
  for (const e of entries) {
    if (e.type !== 'INFERENCE') continue;
    const at = `ledger:${e.id}`;
    for (const p of e.premises) {
      if (ledger.get(p) === undefined)
        issues.push(
          issue('missing_evidence', at, `${e.id} has premise ${p}, which does not exist`, [e.id]),
        );
      const h = restsOnHypothesis(p, new Set());
      if (h !== null)
        issues.push(
          issue(
            'hypothesis_as_premise',
            at,
            `${e.id} rests on ${h}, a HYPOTHESIS. An unverified hypothesis cannot be a premise`,
            [e.id, h],
          ),
        );
    }
    const premises = e.premises.filter(
      (p) => ledger.get(p) !== undefined && ledger.get(p)?.type !== 'HYPOTHESIS',
    );
    const bad = ungroundedNumbers(e.statement, ledger.factsBehind(premises));
    if (bad.length > 0)
      issues.push(
        issue(
          'ungrounded_number',
          at,
          `${e.id}: number(s) ${bad.join(', ')} do not appear in the facts behind its premises`,
          [e.id],
        ),
      );
  }
  return issues;
}

export interface DraftContext {
  ledger: Ledger;
  hypotheses: readonly Hypothesis[];
  store: TelemetryStore;
  incidentId: string;
}

/** Everything about the diagnosis itself. */
export function verifyDraft(draft: DiagnosisDraft, c: DraftContext): VerifierIssue[] {
  const { ledger, hypotheses } = c;
  const issues: VerifierIssue[] = [];
  const byId = new Map(hypotheses.map((h) => [h.id, h]));
  const factIdsOf = (ids: readonly string[]): Set<string> =>
    new Set(ledger.factsBehind(ids).map((f) => f.id));
  const testedFacts = (h: Hypothesis, result: 'supported' | 'contradicted'): string[] =>
    h.predictions.filter((p) => p.result === result).flatMap((p) => p.ledgerEntryIds);

  // ---- root cause ----
  issues.push(
    ...checkClaim(ledger, 'rootCause', draft.rootCause.statement, draft.rootCause.ledgerEntryIds),
  );
  const rootHyp = byId.get(draft.rootCause.hypothesisId);
  if (rootHyp === undefined) {
    issues.push(
      issue(
        'unsupported_logic',
        'rootCause',
        `hypothesis ${draft.rootCause.hypothesisId} does not exist`,
      ),
    );
  } else if (rootHyp.status === 'rejected') {
    issues.push(
      issue(
        'unsupported_logic',
        'rootCause',
        `the root cause is hypothesis ${rootHyp.id} ("${rootHyp.title}"), which the tests rejected: a prediction of it was contradicted`,
      ),
    );
  } else {
    const cited = factIdsOf(draft.rootCause.ledgerEntryIds);
    const supporting = testedFacts(rootHyp, 'supported');
    if (!supporting.some((id) => cited.has(id))) {
      issues.push(
        issue(
          'unsupported_logic',
          'rootCause',
          `the root cause must cite at least one fact that supported a prediction of ${rootHyp.id}: ${supporting.join(', ') || '(none were supported)'}`,
          supporting,
        ),
      );
    }
  }

  // ---- causal chain ----
  const onsets: ({ tsUs: number; resolutionUs: number } | null)[] = [];
  draft.causalChain.forEach((step, i) => {
    const at = `causalChain[${String(i)}]`;
    issues.push(...checkClaim(ledger, at, step.statement, step.ledgerEntryIds));
    if (
      step.service !== undefined &&
      !c.store.getIncident(c.incidentId).services.includes(step.service)
    ) {
      issues.push(
        issue(
          'unsupported_logic',
          at,
          `"${step.service}" is not a service in this incident's telemetry`,
        ),
      );
    }
    const onset = ledger.get(step.onsetEntryId);
    if (!step.ledgerEntryIds.includes(step.onsetEntryId)) {
      issues.push(
        issue(
          'temporal_precedence',
          at,
          `onsetEntryId ${step.onsetEntryId} must be one of the step's ledgerEntryIds`,
        ),
      );
      onsets.push(null);
    } else if (onset === undefined || onset.type !== 'FACT' || onset.occurredAt === undefined) {
      issues.push(
        issue(
          'temporal_precedence',
          at,
          `onsetEntryId ${step.onsetEntryId} must be a FACT that is dated (it says when something began); this step cannot be placed in time`,
        ),
      );
      onsets.push(null);
    } else onsets.push(onset.occurredAt);
  });
  for (let i = 0; i < onsets.length; i++) {
    for (let j = i + 1; j < onsets.length; j++) {
      const cause = onsets[i];
      const effect = onsets[j];
      if (cause === null || cause === undefined || effect === null || effect === undefined)
        continue;
      // cause began in (ts − resolution, ts]; effect had begun by its ts. Certain violation only.
      if (effect.tsUs <= cause.tsUs - cause.resolutionUs) {
        issues.push(
          issue(
            'temporal_precedence',
            `causalChain[${String(j)}]`,
            `effect before cause: step ${String(j)} had begun by ${String(effect.tsUs)} µs, before step ${String(i)} could have begun (${String(cause.tsUs - cause.resolutionUs)} µs at the earliest). A cause must start before its effects`,
            [
              draft.causalChain[i]?.onsetEntryId ?? '',
              draft.causalChain[j]?.onsetEntryId ?? '',
            ].filter((x) => x !== ''),
          ),
        );
      }
    }
  }

  // ---- affected services ----
  const services = c.store.getIncident(c.incidentId).services;
  for (const s of draft.affectedServices) {
    if (!services.includes(s))
      issues.push(
        issue(
          'unsupported_logic',
          'affectedServices',
          `"${s}" is not a service in this incident's telemetry (${services.join(', ')})`,
        ),
      );
  }

  // ---- rejected hypotheses: must match the engine's test results ----
  draft.rejectedHypotheses.forEach((r, i) => {
    const at = `rejectedHypotheses[${String(i)}]`;
    issues.push(...checkClaim(ledger, at, r.reason, r.ledgerEntryIds));
    const h = byId.get(r.hypothesisId);
    if (h === undefined) {
      issues.push(issue('unsupported_logic', at, `hypothesis ${r.hypothesisId} does not exist`));
    } else if (h.status !== 'rejected') {
      issues.push(
        issue(
          'unsupported_logic',
          at,
          `${h.id} ("${h.title}") was not rejected by its tests (status: ${h.status}); it cannot be listed as rejected`,
        ),
      );
    } else {
      const contradicting = testedFacts(h, 'contradicted');
      const cited = factIdsOf(r.ledgerEntryIds);
      if (!contradicting.some((id) => cited.has(id))) {
        issues.push(
          issue(
            'unsupported_logic',
            at,
            `the rejection of ${h.id} must cite a fact that contradicted one of its predictions: ${contradicting.join(', ')}`,
            contradicting,
          ),
        );
      }
    }
  });
  for (const h of hypotheses) {
    if (
      h.status === 'rejected' &&
      h.id !== draft.rootCause.hypothesisId &&
      !draft.rejectedHypotheses.some((r) => r.hypothesisId === h.id)
    ) {
      issues.push(
        issue(
          'unsupported_logic',
          'rejectedHypotheses',
          `${h.id} ("${h.title}") was rejected by its tests and must be listed in rejectedHypotheses with the contradicting evidence`,
        ),
      );
    }
  }

  // ---- unknowns: no citations, so any number must be grounded somewhere in the ledger's facts ----
  const allFacts = ledger.entries.filter((e): e is FactEntry => e.type === 'FACT');
  draft.unknowns.forEach((u, i) => {
    const bad = ungroundedNumbers(u, allFacts);
    if (bad.length > 0)
      issues.push(
        issue(
          'ungrounded_number',
          `unknowns[${String(i)}]`,
          `number(s) ${bad.join(', ')} do not appear in any fact`,
        ),
      );
  });

  // ---- recommendations and follow-ups ----
  draft.recommendations.forEach((r, i) => {
    const at = `recommendations[${String(i)}]`;
    issues.push(...checkClaim(ledger, at, `${r.title}. ${r.rationale}`, r.ledgerEntryIds));
    if (isRevertPatch(r.patch)) {
      const ev = ChangeEventId.safeParse(r.patch.revert).success
        ? c.store.getEvidence(c.incidentId, r.patch.revert)
        : undefined;
      if (ev?.kind !== 'change')
        issues.push(
          issue(
            'missing_evidence',
            at,
            `patch reverts ${r.patch.revert}, which is not a change event in the store`,
          ),
        );
    } else if (r.patch.from !== undefined) {
      // `from` describes the current state, so it is a claim about telemetry. `to` is a proposal.
      const existing = r.ledgerEntryIds.filter((id) => ledger.get(id) !== undefined);
      const from = knobQuantity(r.patch.target, r.patch.from);
      if (groundingOf(from, anchorsOf(ledger.factsBehind(existing))) === null) {
        issues.push(
          issue(
            'ungrounded_number',
            at,
            `patch.from = ${String(r.patch.from)} does not appear in the facts this recommendation cites; cite the fact that shows the current value or omit "from"`,
            existing,
          ),
        );
      }
    }
  });
  draft.followUps.forEach((f, i) => {
    issues.push(
      ...checkClaim(
        ledger,
        `followUps[${String(i)}]`,
        `${f.title}. ${f.rationale}`,
        f.ledgerEntryIds,
      ),
    );
  });
  return issues;
}

export interface VerifyInput extends DraftContext {
  draft: DiagnosisDraft;
}

/** The whole deterministic pass. Empty result = the diagnosis may be published. */
export function verifyDeterministic(input: VerifyInput): VerifierIssue[] {
  const entries = input.ledger.entries;
  const facts = entries.filter((e): e is FactEntry => e.type === 'FACT');
  return [
    ...verifyFacts(input.store, input.incidentId, facts),
    ...verifyInferences(input.ledger, entries),
    ...verifyDraft(input.draft, input),
  ];
}
