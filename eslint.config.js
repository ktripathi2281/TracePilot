// @ts-check
// ESLint flat config. Encodes two architectural rules from the build brief as lint errors:
//
//  1. Information boundary (§1, §0 "honest framing"): the investigator must never see simulator
//     config/internals or eval ground truth. Enforced with `no-restricted-imports` per package.
//  2. Determinism (§2, §12): no wall-clock time or ambient randomness in `sim/` or `analysis/`.
//
// Note: flat config does NOT merge options of the same rule across blocks (the last block wins),
// so each path gets exactly one `no-restricted-imports` entry built from the pieces below.
// tests/lint-rules.test.ts asserts these rules actually fire.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Ground truth lives in eval/. Only eval itself and the CLI (`tracepilot eval`) may import it. */
const NO_EVAL = [
  {
    group: ['@tracepilot/eval', '@tracepilot/eval/*', '**/eval', '**/eval/**'],
    message: 'Only eval/ and the CLI may import the eval harness or ground truth (brief §0, §1).',
  },
];

/** No access to the simulator at all: data must come through the store. */
const NO_SIM = [
  {
    group: [
      '@tracepilot/sim',
      '@tracepilot/sim/*',
      '**/sim',
      '**/sim/**',
      '@tracepilot/replay',
      '@tracepilot/replay/*',
      '**/replay/src',
      '**/replay/src/**',
    ],
    message:
      'This package must not import the simulator or replay (which carries the simulator recording). Read telemetry through @tracepilot/store (brief §1, §6).',
  },
];

/** Public sim entry point allowed (replay runs), deep imports into internals are not. */
const NO_SIM_INTERNALS = [
  {
    group: ['@tracepilot/sim/*', '**/sim/src', '**/sim/src/**'],
    message: 'Import only the public @tracepilot/sim entry point, never sim internals (brief §1).',
  },
];

/** Ambient randomness from node:crypto is banned in deterministic packages. */
const NO_CRYPTO_RANDOM = ['crypto', 'node:crypto'].map((name) => ({
  name,
  importNames: [
    'randomBytes',
    'randomUUID',
    'randomInt',
    'randomFillSync',
    'getRandomValues',
    'webcrypto',
  ],
  message: 'Use the seeded PRNG; ambient randomness breaks determinism (brief §3).',
}));

/**
 * Analysis is pure: no I/O of any kind, and it does not even see the store. It receives
 * telemetry from its caller, so nothing but telemetry can reach it (brief §4).
 */
const NO_IO = [
  {
    group: [
      'fs',
      'node:fs',
      'fs/*',
      'node:fs/*',
      'child_process',
      'node:child_process',
      'net',
      'node:net',
      'http',
      'node:http',
      'https',
      'node:https',
      'better-sqlite3',
      '@tracepilot/store',
      '@tracepilot/store/*',
      '**/store/src/**',
    ],
    message:
      'Analyzers are pure functions over telemetry passed in: no I/O, no store access (brief §4).',
  },
];

/**
 * The store's only file is its own SQLite database. Without filesystem access it cannot read
 * simulator recordings even by accident (Phase 2 information boundary).
 */
const NO_FS = [
  {
    group: ['fs', 'node:fs', 'fs/*', 'node:fs/*'],
    message: 'The store reads and writes only its SQLite database; no direct filesystem access.',
  },
];

/**
 * @param {{ patterns: Array<{group: string[], message: string}>, paths?: Array<{name: string, importNames?: string[], message: string}> }} opts
 * @returns {import('eslint').Linter.RulesRecord}
 */
const restrictImports = ({ patterns, paths = [] }) => ({
  'no-restricted-imports': ['error', { patterns, paths }],
});

const DETERMINISM_MSG =
  'Wall-clock time and ambient randomness are banned here; use virtual time and the seeded PRNG (brief §2, §12).';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.data/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
    },
  },

  // ---- Information boundary -------------------------------------------------------------
  // Default for every file: no eval imports.
  { files: ['**/*.{ts,tsx,js,mjs}'], rules: restrictImports({ patterns: NO_EVAL }) },
  // eval/ and the CLI may import eval and the sim public API.
  {
    files: ['eval/**', 'packages/cli/**'],
    rules: restrictImports({ patterns: NO_SIM_INTERNALS }),
  },
  // replay: the sim public API (it runs the simulator), never eval ground truth.
  {
    files: ['packages/replay/**'],
    rules: restrictImports({ patterns: [...NO_EVAL, ...NO_SIM_INTERNALS] }),
  },
  // agents, schema: no sim, no eval.
  {
    files: ['packages/agents/**', 'packages/schema/**'],
    rules: restrictImports({ patterns: [...NO_EVAL, ...NO_SIM] }),
  },
  // store: no sim, no eval, no filesystem. Its tests may use node:fs to inspect the DB file.
  {
    files: ['packages/store/**'],
    ignores: ['packages/store/**/*.test.ts'],
    rules: restrictImports({ patterns: [...NO_EVAL, ...NO_SIM, ...NO_FS] }),
  },
  {
    files: ['packages/store/**/*.test.ts'],
    rules: restrictImports({ patterns: [...NO_EVAL, ...NO_SIM] }),
  },
  // server: no eval, only the public sim entry (needed for replay in Phase 4/5).
  {
    files: ['apps/server/**'],
    rules: restrictImports({ patterns: [...NO_EVAL, ...NO_SIM_INTERNALS] }),
  },
  // web: talks to the server over HTTP only. It may import the server's API TYPES (erased at
  // build time) but no runtime code from the server or the packages behind it.
  {
    files: ['apps/web/**'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...restrictImports({ patterns: [...NO_EVAL, ...NO_SIM] }),
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@tracepilot/server',
                '@tracepilot/server/*',
                '@tracepilot/agents',
                '@tracepilot/agents/*',
                '@tracepilot/store',
                '@tracepilot/analysis',
              ],
              allowTypeImports: true,
              message:
                'The web UI talks to the server over HTTP; import only types from @tracepilot/server/api-types (brief §1).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ---- Determinism ----------------------------------------------------------------------
  {
    files: ['packages/sim/**', 'packages/analysis/**', 'packages/replay/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: DETERMINISM_MSG },
        { object: 'Date', property: 'now', message: DETERMINISM_MSG },
        { object: 'performance', property: 'now', message: DETERMINISM_MSG },
        { object: 'process', property: 'hrtime', message: DETERMINISM_MSG },
        { object: 'process', property: 'uptime', message: DETERMINISM_MSG },
        { object: 'crypto', property: 'randomUUID', message: DETERMINISM_MSG },
        { object: 'crypto', property: 'getRandomValues', message: DETERMINISM_MSG },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: DETERMINISM_MSG },
        { selector: "CallExpression[callee.name='Date']", message: DETERMINISM_MSG },
      ],
    },
  },
  // analysis must derive everything from telemetry, never from sim config, and does no I/O.
  {
    files: ['packages/analysis/**'],
    rules: restrictImports({
      patterns: [...NO_EVAL, ...NO_SIM, ...NO_IO],
      paths: NO_CRYPTO_RANDOM,
    }),
  },
  {
    files: ['packages/sim/**'],
    rules: restrictImports({ patterns: NO_EVAL, paths: NO_CRYPTO_RANDOM }),
  },
);
