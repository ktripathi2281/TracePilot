// Proves the architectural lint rules in eslint.config.js actually fire (brief §1, §12).
// A lint rule that silently stops matching is worse than none, so this is a real test.
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined) throw new Error(`no lint result for ${filePath}`);
  return result.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

describe('information boundary', () => {
  const forbidden: [string, string][] = [
    ['packages/agents/src/x.ts', "import { a } from '@tracepilot/eval';"],
    ['packages/agents/src/x.ts', "import { a } from '../../../eval/src/index.ts';"],
    ['packages/agents/src/x.ts', "import { a } from '@tracepilot/sim';"],
    ['packages/agents/src/x.ts', "import { a } from '../../sim/src/engine.ts';"],
    ['packages/store/src/x.ts', "import { a } from '@tracepilot/sim';"],
    ['packages/analysis/src/x.ts', "import { a } from '@tracepilot/sim';"],
    ['apps/server/src/x.ts', "import { a } from '@tracepilot/eval';"],
    ['apps/server/src/x.ts', "import { a } from '@tracepilot/sim/internal';"],
    ['apps/server/src/x.ts', "import { a } from '../../../packages/sim/src/engine.ts';"],
    ['apps/web/src/x.ts', "import { a } from '@tracepilot/sim';"],
    ['packages/sim/src/x.ts', "import { a } from '@tracepilot/eval';"],
  ];
  it.each(forbidden)('%s rejects: %s', async (file, code) => {
    expect(await ruleIds(`${code}\nexport const b = a;\n`, file)).toContain(
      'no-restricted-imports',
    );
  });

  const allowed: [string, string][] = [
    ['packages/agents/src/x.ts', "import { a } from '@tracepilot/store';"],
    ['packages/agents/src/x.ts', "import { a } from '@tracepilot/analysis';"],
    ['packages/agents/src/x.ts', "import { a } from '@tracepilot/schema';"],
    ['apps/server/src/x.ts', "import { a } from '@tracepilot/sim';"],
    ['packages/cli/src/x.ts', "import { a } from '@tracepilot/eval';"],
    ['eval/src/x.ts', "import { a } from '@tracepilot/sim';"],
  ];
  it.each(allowed)('%s allows: %s', async (file, code) => {
    expect(await ruleIds(`${code}\nexport const b = a;\n`, file)).not.toContain(
      'no-restricted-imports',
    );
  });
});

describe('determinism', () => {
  const banned = [
    'export const t = Date.now();',
    'export const t = new Date();',
    'export const t = Date();',
    'export const r = Math.random();',
    'export const p = performance.now();',
    'export const h = process.hrtime.bigint();',
    'export const u = crypto.randomUUID();',
  ];
  for (const pkg of ['sim', 'analysis']) {
    it.each(banned)(`packages/${pkg} rejects: %s`, async (code) => {
      const ids = await ruleIds(code, `packages/${pkg}/src/x.ts`);
      expect(
        ids.some((id) => id === 'no-restricted-properties' || id === 'no-restricted-syntax'),
      ).toBe(true);
    });
    it(`packages/${pkg} rejects random imports from node:crypto`, async () => {
      const ids = await ruleIds(
        "import { randomUUID } from 'node:crypto';\nexport const u = randomUUID();\n",
        `packages/${pkg}/src/x.ts`,
      );
      expect(ids).toContain('no-restricted-imports');
    });
  }

  it('allows wall-clock time outside sim/analysis (e.g. CLI logging)', async () => {
    expect(await ruleIds('export const t = Date.now();', 'packages/cli/src/x.ts')).toEqual([]);
  });
});

describe('type safety and error handling', () => {
  it('rejects explicit any', async () => {
    expect(await ruleIds('export const x: any = 1;', 'packages/schema/src/x.ts')).toContain(
      '@typescript-eslint/no-explicit-any',
    );
  });
  it('rejects silent catches', async () => {
    expect(
      await ruleIds(
        'export function f(g: () => void) { try { g(); } catch { } }',
        'packages/store/src/x.ts',
      ),
    ).toContain('no-empty');
  });
});
