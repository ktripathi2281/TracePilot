// Token and cost accounting per investigation, with a hard budget (brief §8).
//
// These numbers come from the API's usage reports (or the cassette's recorded ones), never from
// model text.

import type { LlmUsage } from './types.ts';

export class BudgetExceededError extends Error {}

/** USD per million tokens: input, output, cache read. Cache writes cost 1.25 × input. */
const PRICES: Readonly<Record<string, { input: number; output: number; cacheRead: number }>> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Everything the models read or wrote: the number the budget is enforced on. */
  totalTokens: number;
  budgetTokens: number;
  /** Estimate at list prices; null if a model's price is unknown. */
  estimatedCostUsd: number | null;
  byRole: Record<string, { calls: number; totalTokens: number }>;
}

export class UsageMeter {
  private calls = 0;
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheCreation = 0;
  private cost: number | null = 0;
  private readonly byRole: Record<string, { calls: number; totalTokens: number }> = {};

  readonly budgetTokens: number;

  constructor(budgetTokens: number) {
    this.budgetTokens = budgetTokens;
    if (!Number.isFinite(budgetTokens) || budgetTokens <= 0)
      throw new Error('token budget must be a positive number');
  }

  get totalTokens(): number {
    return this.input + this.output + this.cacheRead + this.cacheCreation;
  }

  /** Call before every request: refuses to start one once the budget is spent. */
  assertWithinBudget(role: string): void {
    if (this.totalTokens >= this.budgetTokens) {
      throw new BudgetExceededError(
        `token budget exhausted before a ${role} call: ${String(this.totalTokens)} of ${String(this.budgetTokens)} tokens used in ${String(this.calls)} calls (MAX_TOKENS_PER_INVESTIGATION)`,
      );
    }
  }

  add(role: string, model: string, u: LlmUsage): void {
    this.calls++;
    this.input += u.inputTokens;
    this.output += u.outputTokens;
    this.cacheRead += u.cacheReadTokens;
    this.cacheCreation += u.cacheCreationTokens;
    const r = (this.byRole[role] ??= { calls: 0, totalTokens: 0 });
    r.calls++;
    r.totalTokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    const p = PRICES[model];
    if (p === undefined) this.cost = null;
    else if (this.cost !== null) {
      this.cost +=
        (u.inputTokens * p.input +
          u.cacheCreationTokens * p.input * 1.25 +
          u.cacheReadTokens * p.cacheRead +
          u.outputTokens * p.output) /
        1_000_000;
    }
  }

  summary(): UsageSummary {
    return {
      calls: this.calls,
      inputTokens: this.input,
      outputTokens: this.output,
      cacheReadTokens: this.cacheRead,
      cacheCreationTokens: this.cacheCreation,
      totalTokens: this.totalTokens,
      budgetTokens: this.budgetTokens,
      estimatedCostUsd: this.cost === null ? null : Math.round(this.cost * 10_000) / 10_000,
      byRole: this.byRole,
    };
  }
}
