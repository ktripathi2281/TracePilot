// Test fixture: scenario A's telemetry in an in-memory store, and a scripted investigation of it.
//
// The scripted investigation is driven by a TEST DOUBLE (`ScriptedLlm`), not a model. It exists so
// the engine (tools, ledger, hypothesis tests, skeptic rules, verifier, revision rounds) can be
// tested on real telemetry. It proves nothing about how a model performs: Gate 3's recorded run
// does that (gate3.test.ts).

import {
  DiagnosisDraft,
  Ledger,
  investigate,
  type InvestigateOptions,
  type Investigation,
} from '@tracepilot/agents';
import { ScriptedLlm, protocolScript, type Script } from '@tracepilot/agents/testing';
import type { Diagnosis, FactEntry } from '@tracepilot/schema';
import { recordPoolExhaustion, runSimulation } from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';

export interface ScenarioA {
  store: TelemetryStore;
  incidentId: string;
}

export function loadScenarioA(seed = 42): ScenarioA {
  const rec = recordPoolExhaustion(seed);
  const { telemetry } = runSimulation(rec.config, rec.workload);
  const store = new TelemetryStore(':memory:');
  const { incident } = store.ingest(telemetry, { source: 'synthetic' });
  return { store, incidentId: incident.id };
}

export const TEST_MODEL = 'test-double';

export async function runScripted(
  a: ScenarioA,
  script: Script = protocolScript(),
  over: Partial<InvestigateOptions> = {},
): Promise<{ investigation: Investigation; llm: ScriptedLlm }> {
  const llm = new ScriptedLlm(script);
  const investigation = await investigate({
    store: a.store,
    incidentId: a.incidentId,
    llm,
    model: TEST_MODEL,
    maxTokens: 1_000_000,
    ...over,
  });
  return { investigation, llm };
}

/** The published diagnosis, back in the form a role submits (engine-added fields removed). */
export function toDraft(d: Diagnosis): DiagnosisDraft {
  return DiagnosisDraft.parse({
    rootCause: {
      statement: d.rootCause.statement,
      hypothesisId: d.rootCause.hypothesisId,
      ledgerEntryIds: d.rootCause.ledgerEntryIds,
    },
    causalChain: d.causalChain,
    affectedServices: d.affectedServices,
    rejectedHypotheses: d.rejectedHypotheses.map((r) => ({
      hypothesisId: r.hypothesisId,
      reason: r.reason,
      ledgerEntryIds: r.ledgerEntryIds,
    })),
    unknowns: d.unknowns,
    recommendations: d.recommendations.map((r) => ({
      title: r.title,
      rationale: r.rationale,
      patch: r.patch,
      addresses: r.addresses,
      ledgerEntryIds: r.ledgerEntryIds,
    })),
    followUps: d.followUps,
  });
}

export const factByKey = (inv: Investigation, key: string): FactEntry => {
  const f = inv.ledger.find((e): e is FactEntry => e.type === 'FACT' && e.findingKey === key);
  if (f === undefined) throw new Error(`no fact with finding key ${key}`);
  return f;
};

/** A copy of the investigation's ledger with one entry replaced: what a tampered ledger looks like. */
export function ledgerWith(
  inv: Investigation,
  id: string,
  change: (e: FactEntry) => FactEntry,
): Ledger {
  return Ledger.from(
    inv.ledger.map((e) => {
      if (e.id !== id) return e;
      if (e.type !== 'FACT') throw new Error(`${id} is not a FACT`);
      return change(structuredClone(e));
    }),
  );
}
