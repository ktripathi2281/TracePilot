// Gate 3 (brief §11): `tracepilot investigate` on scenario A returns a diagnosis that passes the
// verifier, rejects at least the "slow DB" alternative with cited evidence, and does not blame
// the red herrings.
//
// The gate is about a REAL model run. It is checked here by replaying the cassette of one:
//
//   eval/cassettes/<incidentId>.json     recorded with TRACEPILOT_LLM=record (see NOTES.md)
//
// Replay re-runs the whole investigation (tools, hypothesis tests, skeptic, verifier) against the
// telemetry store; only the model's turns come from the cassette. If prompts, tools or telemetry
// have changed since the recording, replay fails with a cassette miss and the run must be
// recorded again.
//
// While no such cassette exists these tests are SKIPPED, and Gate 3 is not verified. The scripted
// tests in investigation.test.ts do not count: they use a test double, not a model.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CassetteLlm,
  DEFAULT_TOKEN_BUDGET,
  Ledger,
  investigate,
  verifyDeterministic,
  type Effort,
  type Investigation,
} from '@tracepilot/agents';
import type { FactEntry, Hypothesis } from '@tracepilot/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadScenarioA, toDraft } from './scenario-a.ts';

const CASSETTE_DIR = fileURLToPath(new URL('../cassettes/', import.meta.url));

const GroundTruth = z.object({
  rootCause: z.object({ changeEventId: z.string(), service: z.string() }),
  redHerrings: z.array(
    z.object({
      kind: z.enum(['change', 'disturbance']),
      changeEventId: z.string().optional(),
      service: z.string().optional(),
      fromUs: z.number().optional(),
      toUs: z.number().optional(),
    }),
  ),
});
const truth = GroundTruth.parse(
  JSON.parse(
    readFileSync(new URL('../ground-truth/pool-exhaustion.json', import.meta.url), 'utf8'),
  ),
);

const CassetteHeader = z.object({
  upstream: z.string(),
  entries: z.array(
    z.object({ request: z.object({ model: z.string(), effort: z.string(), tools: z.number() }) }),
  ),
});

const a = loadScenarioA(42);
const cassettePath = `${CASSETTE_DIR}${a.incidentId}.json`;
const header = existsSync(cassettePath)
  ? CassetteHeader.parse(JSON.parse(readFileSync(cassettePath, 'utf8')))
  : null;
const recordedLive = header !== null && header.upstream === 'live' && header.entries.length > 0;

describe('cassettes in the repository', () => {
  it('are all recordings of the live API, never of a test double', () => {
    const files = existsSync(CASSETTE_DIR)
      ? readdirSync(CASSETTE_DIR).filter((f) => f.endsWith('.json'))
      : [];
    for (const f of files) {
      const h = CassetteHeader.parse(JSON.parse(readFileSync(`${CASSETTE_DIR}${f}`, 'utf8')));
      expect(h.upstream, f).toBe('live');
    }
  });
});

describe.skipIf(!recordedLive)(
  `Gate 3: recorded investigation of scenario A (needs eval/cassettes/${a.incidentId}.json, see NOTES.md)`,
  () => {
    let inv: Investigation;
    const hyp = (kind: string): Hypothesis | undefined =>
      inv.hypotheses.find((h) => h.kind === kind);

    beforeAll(async () => {
      if (header === null) throw new Error('unreachable: suite is skipped without a cassette');
      // Replay with the settings the run was recorded with. The verifier's logic pass is the
      // only role that is offered exactly one tool.
      const first = header.entries[0]?.request;
      const reviewer = header.entries.find((e) => e.request.tools === 1)?.request;
      inv = await investigate({
        store: a.store,
        incidentId: a.incidentId,
        llm: new CassetteLlm('replay', cassettePath),
        model: first?.model ?? '',
        verifierModel: reviewer?.model ?? first?.model ?? '',
        effort: (first?.effort ?? 'medium') as Effort,
        maxTokens: DEFAULT_TOKEN_BUDGET,
      });
    });

    it('is a recorded run of a real model, within the token budget', () => {
      expect(inv.llm).toMatchObject({ mode: 'replay', recorded: true });
      expect(inv.usage.totalTokens).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
      expect(inv.outcome).toBe('diagnosed');
    });

    it('returns a diagnosis that passes the verifier', () => {
      const d = inv.diagnosis;
      if (d === null) throw new Error('no diagnosis');
      const last = inv.verification.at(-1);
      expect(last?.deterministicIssues).toEqual([]);
      expect(last?.llmPass).toBe('ran');
      expect(last?.llmIssues).toEqual([]);
      expect(d.unresolvedIssues).toEqual([]);
      // Checked again here, independently of the run: every fact against the store, every claim
      // against its facts.
      expect(
        verifyDeterministic({
          draft: toDraft(d),
          ledger: Ledger.from(inv.ledger),
          hypotheses: inv.hypotheses,
          store: a.store,
          incidentId: a.incidentId,
        }),
      ).toEqual([]);
    });

    it('tests pool-too-small, hold-and-wait and DB-slow against each other', () => {
      for (const kind of ['pool_capacity', 'hold_and_wait', 'db_slow'])
        expect(hyp(kind), kind).toBeDefined();
    });

    it('rejects the "slow DB" alternative with cited evidence', () => {
      const d = inv.diagnosis;
      if (d === null) throw new Error('no diagnosis');
      const db = hyp('db_slow');
      expect(db?.status).toBe('rejected');
      const rejection = d.rejectedHypotheses.find((r) => r.hypothesisId === db?.id);
      expect(rejection).toBeDefined();
      const contradicting = (db?.predictions ?? [])
        .filter((p) => p.result === 'contradicted')
        .flatMap((p) => p.ledgerEntryIds);
      const cited = (rejection?.ledgerEntryIds ?? []).filter((id) => contradicting.includes(id));
      expect(cited.length).toBeGreaterThan(0);
      for (const id of cited) {
        const fact = inv.ledger.find((e) => e.id === id);
        if (fact?.type !== 'FACT') throw new Error(`${id} is not a FACT`);
        for (const ev of fact.evidenceIds)
          expect(a.store.getEvidence(a.incidentId, ev), ev).toBeDefined();
      }
    });

    it('names the structural root cause, not just a pool that is too small', () => {
      const d = inv.diagnosis;
      if (d === null) throw new Error('no diagnosis');
      expect(d.rootCause.kind).toBe('hold_and_wait');
      expect(hyp('pool_capacity')?.status).toBe('rejected');
      const cited = new Set(Ledger.from(inv.ledger).factsBehind(d.rootCause.ledgerEntryIds));
      const keys = [...cited].map((f) => f.findingKey);
      expect(
        keys.some((k) => /^hold_and_wait\.[^.]+\.(detected|nested_wait|idle_held)$/.test(k)),
      ).toBe(true);
      // Still gives replay something to try.
      expect(d.recommendations.length).toBeGreaterThan(0);
    });

    it('does not blame the red herrings', () => {
      const d = inv.diagnosis;
      if (d === null) throw new Error('no diagnosis');
      const change = truth.redHerrings.find((h) => h.kind === 'change');
      const blip = truth.redHerrings.find((h) => h.kind === 'disturbance');
      const isHerring = (f: FactEntry): boolean =>
        (change?.changeEventId !== undefined && f.evidenceIds.includes(change.changeEventId)) ||
        (blip?.fromUs !== undefined &&
          blip.toUs !== undefined &&
          f.occurredAt !== undefined &&
          f.occurredAt.tsUs >= blip.fromUs &&
          f.occurredAt.tsUs <= blip.toUs + 60_000_000);
      const ledger = Ledger.from(inv.ledger);
      const blamed = ledger.factsBehind([
        ...d.rootCause.ledgerEntryIds,
        ...d.causalChain.flatMap((s) => s.ledgerEntryIds),
        ...d.recommendations
          .filter((r) => r.addresses === 'cause')
          .flatMap((r) => r.ledgerEntryIds),
      ]);
      expect(blamed.filter(isHerring).map((f) => `${f.id} ${f.findingKey}`)).toEqual([]);
      expect(d.recommendations.map((r) => r.patch)).not.toContainEqual({
        revert: change?.changeEventId,
      });
      // And it does point at the change that did it.
      const culprit = truth.rootCause.changeEventId;
      const pointsAtCulprit =
        d.recommendations.some((r) => 'revert' in r.patch && r.patch.revert === culprit) ||
        ledger
          .factsBehind(d.causalChain.flatMap((s) => s.ledgerEntryIds))
          .some((f) => f.evidenceIds.includes(culprit));
      expect(pointsAtCulprit).toBe(true);
    });

    it('had its leading hypothesis challenged by the skeptic with new queries', () => {
      expect(inv.skeptic).not.toBeNull();
      expect(inv.skeptic?.newQueries.length).toBeGreaterThanOrEqual(3);
    });
  },
);
