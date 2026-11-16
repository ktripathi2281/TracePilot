// Evidence ledger (brief §6).
//
// - FACT entries are created ONLY here, from tool findings. The LLM never writes one.
// - INFERENCE entries are written by an LLM role: a statement, a named rule and premises.
// - HYPOTHESIS entries are unverified and may never support anything.

import {
  LedgerEntry,
  type FactEntry,
  type HypothesisEntry,
  type InferenceEntry,
  type LedgerAuthor,
} from '@tracepilot/schema';
import { callKey, type Finding } from './tools/types.ts';

export class LedgerError extends Error {}

export class Ledger {
  private readonly list: LedgerEntry[] = [];
  private readonly byId = new Map<string, LedgerEntry>();
  /** `${callKey}#${findingKey}` → fact id, so the same finding is one entry however often it is seen. */
  private readonly factIndex = new Map<string, string>();
  private seq = 0;

  private nextId(): string {
    return `le_${(++this.seq).toString(36)}`;
  }

  private add<T extends LedgerEntry>(entry: T): T {
    const parsed = LedgerEntry.parse(entry) as T;
    this.list.push(parsed);
    this.byId.set(parsed.id, parsed);
    return parsed;
  }

  /** Registers the findings of one tool call as FACTs. Returns their entries in order. */
  recordFindings(
    author: LedgerAuthor,
    tool: string,
    args: Record<string, unknown>,
    findings: readonly Finding[],
  ): FactEntry[] {
    const ck = callKey(tool, args);
    return findings.map((f) => {
      const indexKey = `${ck}#${f.key}`;
      const existing = this.factIndex.get(indexKey);
      if (existing !== undefined) return this.byId.get(existing) as FactEntry;
      const entry = this.add<FactEntry>({
        id: this.nextId(),
        author,
        type: 'FACT',
        statement: f.statement,
        tool,
        args,
        findingKey: f.key,
        value: f.value,
        evidenceIds: f.evidenceIds,
        quantities: f.quantities,
        derived: f.derived,
        ...(f.occurredAt === undefined ? {} : { occurredAt: f.occurredAt }),
      });
      this.factIndex.set(indexKey, entry.id);
      return entry;
    });
  }

  addInference(
    author: LedgerAuthor,
    statement: string,
    rule: string,
    premises: readonly string[],
  ): InferenceEntry {
    const missing = premises.filter((p) => !this.byId.has(p));
    if (missing.length > 0)
      throw new LedgerError(`unknown premise ledger entries: ${missing.join(', ')}`);
    const hyp = premises.filter((p) => this.byId.get(p)?.type === 'HYPOTHESIS');
    if (hyp.length > 0) {
      throw new LedgerError(
        `a HYPOTHESIS cannot be a premise (${hyp.join(', ')}); cite FACT or INFERENCE entries`,
      );
    }
    return this.add<InferenceEntry>({
      id: this.nextId(),
      author,
      type: 'INFERENCE',
      statement,
      rule,
      premises: [...new Set(premises)],
    });
  }

  addHypothesis(author: LedgerAuthor, statement: string, hypothesisId: string): HypothesisEntry {
    return this.add<HypothesisEntry>({
      id: this.nextId(),
      author,
      type: 'HYPOTHESIS',
      statement,
      hypothesisId,
    });
  }

  get(id: string): LedgerEntry | undefined {
    return this.byId.get(id);
  }

  get entries(): readonly LedgerEntry[] {
    return this.list;
  }

  /**
   * The FACTs that `ids` rest on, following INFERENCE premises. HYPOTHESIS entries contribute
   * nothing (the verifier reports them separately).
   */
  factsBehind(ids: readonly string[]): FactEntry[] {
    const out = new Map<string, FactEntry>();
    const seen = new Set<string>();
    const stack = [...ids];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const e = this.byId.get(id);
      if (e === undefined) continue;
      if (e.type === 'FACT') out.set(e.id, e);
      else if (e.type === 'INFERENCE') stack.push(...e.premises);
    }
    return [...out.values()];
  }

  /** Restores a ledger from stored entries (verifier tests, loading an investigation). */
  static from(entries: readonly LedgerEntry[]): Ledger {
    const ledger = new Ledger();
    for (const raw of entries) {
      const e = LedgerEntry.parse(raw);
      ledger.list.push(e);
      ledger.byId.set(e.id, e);
      if (e.type === 'FACT')
        ledger.factIndex.set(`${callKey(e.tool, e.args)}#${e.findingKey}`, e.id);
      const n = Number.parseInt(e.id.slice(3), 36);
      if (Number.isFinite(n) && n > ledger.seq) ledger.seq = n;
    }
    return ledger;
  }
}
