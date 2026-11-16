// Executes data tools for an LLM role: validates the input, runs the tool, records its findings
// as FACTs, and renders a compact result (summary + fact IDs + rows) for the model.

import type { FactEntry, LedgerAuthor } from '@tracepilot/schema';
import { z } from 'zod';
import type { Ledger } from '../ledger.ts';
import type { ToolContext } from './context.ts';
import { DATA_TOOLS } from './registry.ts';
import { callKey, type ToolDef, type ToolOutput } from './types.ts';

export interface ToolRunOk {
  ok: true;
  tool: string;
  args: Record<string, unknown>;
  callKey: string;
  output: ToolOutput;
  facts: FactEntry[];
  /** What the LLM sees. */
  text: string;
}
export interface ToolRunError {
  ok: false;
  tool: string;
  error: string;
}
export type ToolRun = ToolRunOk | ToolRunError;

const byName = new Map<string, ToolDef>(DATA_TOOLS.map((t) => [t.name, t]));

export const isDataTool = (name: string): boolean => byName.has(name);

/** Validates arguments against a data tool's schema. Returns the parsed args or an error message. */
export function parseToolArgs(
  name: string,
  raw: unknown,
): { args: Record<string, unknown> } | { error: string } {
  const tool = byName.get(name);
  if (tool === undefined)
    return { error: `unknown tool "${name}". Data tools: ${[...byName.keys()].join(', ')}` };
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      error: `invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    };
  }
  return { args: parsed.data as Record<string, unknown> };
}

/** Runs a data tool without touching any ledger. Used by the verifier to recompute facts. */
export function computeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): ToolOutput {
  const tool = byName.get(name);
  if (tool === undefined) throw new Error(`unknown tool "${name}"`);
  return tool.run(ctx, tool.input.parse(args));
}

export class ToolRunner {
  /** Every distinct call made so far, by any role, in order. */
  readonly calls: { author: LedgerAuthor; callKey: string }[] = [];

  private readonly ctx: ToolContext;
  private readonly ledger: Ledger;

  constructor(ctx: ToolContext, ledger: Ledger) {
    this.ctx = ctx;
    this.ledger = ledger;
  }

  hasRun(key: string): boolean {
    return this.calls.some((c) => c.callKey === key);
  }

  run(author: LedgerAuthor, name: string, raw: unknown): ToolRun {
    const parsed = parseToolArgs(name, raw);
    if ('error' in parsed) return { ok: false, tool: name, error: parsed.error };
    let output: ToolOutput;
    try {
      output = computeTool(this.ctx, name, parsed.args);
    } catch (e) {
      // Tool errors go back to the model as a tool error; they are not swallowed.
      return { ok: false, tool: name, error: e instanceof Error ? e.message : String(e) };
    }
    const key = callKey(name, parsed.args);
    if (!this.hasRun(key)) this.calls.push({ author, callKey: key });
    const facts = this.ledger.recordFindings(author, name, parsed.args, output.findings);
    const text = JSON.stringify({
      summary: output.summary,
      facts: facts.map((f) => ({
        id: f.id,
        key: f.findingKey,
        value: f.value,
        statement: f.statement,
      })),
      ...(output.rows === undefined ? {} : { rows: output.rows }),
      ...(output.notes === undefined ? {} : { notes: output.notes }),
    });
    return { ok: true, tool: name, args: parsed.args, callKey: key, output, facts, text };
  }
}

/** Tool definitions in the shape the Messages API expects. */
export function toolSpecs(
  tools: readonly { name: string; description: string; input: z.ZodType }[],
): {
  name: string;
  description: string;
  input_schema: { type: 'object'; [k: string]: unknown };
}[] {
  return tools.map((t) => {
    const { $schema: _schema, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: { ...schema, type: 'object' },
    };
  });
}
