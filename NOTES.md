# TracePilot — Decision Log

Appended at the end of every phase (brief §11). Newest phase at the bottom.

---

## Phase 0 — Scaffold (2026-11-15)

### What exists

- pnpm workspace: `packages/{schema,sim,store,analysis,agents,cli}`, `apps/{server,web}`, `eval/`.
  Everything except `schema` is a typed placeholder (`export {}`) with its dependency edges
  already declared in `package.json`.
- `@tracepilot/schema`: Zod schemas + types for virtual time, OTel-shaped IDs, evidence IDs, spans,
  logs, metrics, change events, pod events, dependency graph, evidence ledger
  (FACT/INFERENCE/HYPOTHESIS), hypotheses/predictions, patches, diagnosis, verifier issues.
- ESLint flat config enforcing the information boundary and the determinism ban; a test
  (`tests/lint-rules.test.ts`) proves each rule fires.
- `pnpm run ci` (`scripts/ci.mjs`): format check → lint → typecheck (every project) → tests.
  `.github/workflows/ci.yml` runs the same script.
- Checks at commit time: format ✔, lint ✔ (0 warnings), typecheck ✔ (10 projects), tests ✔ (58).

### Decisions (and deviations from the brief)

1. **Node ≥ 22.12, not 20+.** Node 20 reached end-of-life in April 2026, and Vitest 5 requires
   `^22.12 || ^24 || >=26`. `engines` + `engine-strict` enforce it. CI uses Node 22.
2. **TypeScript 6.0.3, not 7.x.** TS 7 is the latest release, but typescript-eslint 8.72 supports
   `<6.1`. Revisit when typescript-eslint supports TS 7.
3. **pnpm 10.34.9** pinned via `packageManager` (run through corepack: `corepack pnpm …`). No
   global pnpm is needed; `scripts/ci.mjs` re-invokes whatever pnpm launched it, and
   `scripts/typecheck.mjs` calls the root `tsc` directly. Use `pnpm run ci`, not `pnpm ci`
   (`ci` is a name pnpm reserves for itself).
4. **Internal packages ship TypeScript source** (`exports: "./src/index.ts"`, `moduleResolution:
Bundler`, `allowImportingTsExtensions`, `noEmit`). No build step: Vitest and Vite consume TS
   directly; the CLI will run through a TS runner (tsx or Node type-stripping) in Phase 1. Imports
   use explicit `.ts` extensions so Node's type-stripping can run them later if we drop tsx.
5. **Zod 4** (`z.strictObject` everywhere at boundaries, so unknown keys are rejected). Zod 4's
   `z.number()` already rejects NaN/±Infinity, and `.int()` limits values to safe integers.
6. **Interpreting the import rule (§1).** The brief says agents/server may import "only the schema
   package and store", but agent tools are by definition wrappers over `analysis` too (§6), and the
   server must call the simulator to run replays (§7, Phase 4/5). What is enforced:
   | Package                                                                                     | eval | sim (public entry) | sim internals |
   | ------------------------------------------------------------------------------------------- | ---- | ------------------ | ------------- |
   | agents, store, schema, web                                                                  | ✖    | ✖                  | ✖             |
   | analysis                                                                                    | ✖    | ✖                  | ✖             |
   | server                                                                                      | ✖    | ✔ (replay)         | ✖             |
   | cli, eval                                                                                   | ✔    | ✔                  | ✖             |
   | sim                                                                                         | ✖    | n/a                | n/a           |
   | `analysis` is also banned from `sim` because the dependency graph must come from spans, not |
   | config (§4.3). Relative-path escapes (`../../eval/...`, `../sim/src/...`) are blocked too.  |
7. **Determinism lint** in `sim/` and `analysis/`: bans `Math.random`, `Date.now`, `new Date()`,
   `Date()`, `performance.now`, `process.hrtime`, `process.uptime`, `crypto.randomUUID`,
   `crypto.getRandomValues`, and importing random functions from `node:crypto` (hashing stays
   allowed, the determinism tests need it).
8. **Non-type-aware lint** (`typescript-eslint` `strict` + `stylistic`). Type-aware rules would add
   `no-floating-promises` / `no-unsafe-*`, but they break `lintText` on virtual files used by the
   lint-rule tests and slow lint down. TS `strict` + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes` cover most of the "no any" goal. Revisit in Phase 3, where async
   LLM code makes `no-floating-promises` worth having.
9. **Evidence ID formats.** `sp_<16-hex spanId>`, `lg_<base36>`, `mt_<service>_<metric>_<ts>`,
   `ev_<base36>` (change events), **`pe_<base36>` for pod events** (the brief lists only `ev_`;
   a separate prefix lets the verifier pick the right table without a lookup). Service names
   are kebab-case with **no underscores**, so metric IDs parse unambiguously (the timestamp is
   always the last `_`-segment). Non-evidence IDs: `le_` ledger, `hy_` hypothesis, `pr_` prediction,
   `rc_` recommendation, `in_` incident.
10. **Metric units are fixed per name** (`METRIC_UNITS`): latencies in µs (same unit as virtual
    time), `request_rate` in req/s, `error_rate` and `cpu_throttled_ratio` as ratios in [0, 1]
    (the schema enforces the range), memory in bytes. The metric name set is a closed enum, so
    adding a metric is a deliberate schema change.
11. **Patch shape** follows the brief literally: `{target, from?, to}` or `{revert: <ev_id>}`; no
    `kind` field. All knob values are non-negative integers. The schema checks target _syntax_
    only (`db.pool.capacity`, `db.acquireTimeoutUs`, `cache.capacity`,
    `<name>.{workers,replicas,memoryLimit,cpuLimit,timeoutUs,queueLimit,consumers}`); whether
    the target exists in a given system model is the replay engine's job (Phase 4).
12. **Ledger shape.** FACT carries `tool` + non-empty `evidenceIds` + `quantities[]` (each quoted
    number with its evidence ID, field and unit, so the verifier can re-read and compare it).
    The schema rejects a quantity that cites evidence outside the entry's `evidenceIds`. FACTs
    cannot carry premises. INFERENCE needs a named `rule` and ≥1 premise. The rules "a HYPOTHESIS
    can't be a premise" and "temporal precedence" need the whole ledger and store, so they belong to
    the verifier (Phase 3), not the schema.
13. **No confidence field on hypotheses.** Hypotheses have no confidence field, so the LLM has
    nowhere to state one. `Diagnosis.confidence` holds a score plus its `basis` (prediction counts),
    and the Phase 3 rubric computes it. `Diagnosis.unresolvedIssues` carries the verifier failures
    left after the max revision rounds, so they are always visible.
14. Root span parent is `parentSpanId: null`, not an absent field, so JSON and SQLite rows have
    explicit nulls.

### Assumptions

- The DB is modeled as a service named `db` (metrics like `pool_in_use` use `service: "db"`).
  Phase 1 may choose otherwise; the schema does not depend on it.
- `DependencyGraph` is provisional; the Phase 2 analyzer may refine its fields.

### Known gaps

- Metric evidence IDs assume `(service, name, ts)` is unique. Label-split series (e.g. per pod in
  Scenario D) would collide. Fix when Scenario D needs it, e.g. with a label-hash suffix.
- `apps/web` and `apps/server` are placeholders with no React/Vite/Tailwind/Hono dependencies yet
  (Phase 5).
- No CLI binary yet (Phase 1 adds `tracepilot sim run`).
- `better-sqlite3` is not installed yet (Phase 2). pnpm 10 blocks dependency build scripts by
  default, so it must be added to `pnpm.onlyBuiltDependencies`.
