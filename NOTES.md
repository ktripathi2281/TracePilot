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

---

## Phase 1 — Simulator, scenario A, validity tests (2026-11-15)

### What exists

- `packages/sim`
  - `engine.ts`: discrete-event engine (virtual clock, binary heap ordered by time then
    scheduling sequence). Services with replicas/workers/queues/deadlines, one shared connection
    pool (FIFO, acquire timeout), a DB executor with `maxParallelQueries`, cancellation.
  - `model.ts`: declarative system model, workload, recording (all plain JSON, Zod-validated).
  - `rng.ts`: counter-based randomness; `workload.ts`: workload generator;
    `knobs.ts`: knob addressing + `applyPatches`; `hash.ts`; `summary.ts`.
  - `scenarios/pool-exhaustion.ts`: scenario A. `scripts/calibrate.ts`: calibration report
    (`pnpm run calibrate [seeds…]`).
- `packages/cli`: `tracepilot sim run --scenario pool-exhaustion --seed 42 --out .data/` writes
  `spans.jsonl`, `logs.jsonl`, `metrics.jsonl`, `change-events.jsonl`, `pod-events.jsonl`,
  `recording.json` (replay input) and `manifest.json` (telemetry hash + counts). Other commands
  answer "not implemented yet (Phase N)".
- `eval/ground-truth/pool-exhaustion.json`: root cause, causal chain, red herrings, fixes.
- Schema additions: span name `db.transaction`; span attributes `db.statement`,
  `db.queue_wait_us`, `http.status_code`, `peer.service`, `cancelled`, `retry.attempt`.
- Checks at commit time: format ✔, lint ✔, typecheck ✔, tests ✔ (138, about 35 s).

### Gate 1 status: passes

| §3 validity test               | Result                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Determinism                 | Same scenario + seed + workload ⇒ identical SHA-256 over all telemetry; different seed ⇒ different hash.                                                     |
| 2. Identity replay             | Recording → JSON → reload → run reproduces the telemetry hash; also end to end through the CLI's files on disk.                                              |
| 3. Monotonicity                | Holds with one precondition; see "Monotonicity" below.                                                                                                       |
| 4. Conservation / Little's law | L = λW within 1% at every service, at the pool and at the DB executor; all arrivals accounted for; all resources free after an incident plus a drain period. |
| 5. Isolation of randomness     | Pool 30 vs 64: 96k draws made by both runs, 0 differ. Changing fan-out 1 → 4 leaves existing draws unchanged.                                                |

Two mutation checks were run by hand and both were caught: making a draw depend on pool state
fails test 5; leaking a connection on transaction rollback fails the drain test in test 4.

Scenario A, seed 42 (`pnpm run calibrate` prints these; `scenario-a.test.ts` asserts them, and the
core ones for seeds 3 and 7 too):

| Window                   | Checkout rate | Errors | p99    | Pool in use   | Wait queue | Query exec p95 |
| ------------------------ | ------------- | ------ | ------ | ------------- | ---------- | -------------- |
| Baseline T+1–6 min       | 81.0 req/s    | 0%     | 135 ms | 11.9/30 (40%) | 0          | 65.9 ms        |
| Payment blip T+7:00–7:20 | 79.8 req/s    | 0%     | 372 ms | 18.5/30       | 0          | 65.7 ms        |
| Incident T+11–15 min     | 80.1 req/s    | 98.3%  | 16.3 s | 30/30         | 262        | 69.0 ms        |

Counterfactuals on the recorded workload (incident window), all asserted in tests:

| Patch                            | Checkout errors | Checkout p99 | Notes                                                             |
| -------------------------------- | --------------- | ------------ | ----------------------------------------------------------------- |
| none (recorded)                  | 98.3%           | 16.3 s       | 2970 acquire timeouts                                             |
| `db.pool.capacity` 30 → 64       | 0%              | 397 ms       | resolved; DB executor now queues (depth ≈ 8, exec p95 96 ms)      |
| revert `ev_2` (deploy)           | 0%              | 134 ms       | back to baseline                                                  |
| revert `ev_1` (inventory tweak)  | 98.3%           | 16.3 s       | every request, span and metric identical                          |
| `checkout.workers` 60 → 20       | 20.8%           | 1.0 s        | no timeouts; failures are fast 503s from checkout's queue         |
| `db.acquireTimeoutUs` 5 s → 15 s | 100%            | 20.0 s       | worse; stock errors 11% → 54%                                     |
| `db.pool.capacity` = 200         | 0%              | 467 ms       | no acquire wait at all; DB executor at ~93% with a standing queue |

Pool sweep (error rate): 20: 100%, 25: 99%, 30: 98%, 35: 99%, 40: 98%, 45: 65%, 50: 62%,
64: 0%, 80: 0%, 120: 0%. The knee is between 50 and 64.

### Decisions

1. **Why the pool exhausts: hold-and-wait.** `checkout` wraps an order in a DB transaction and
   keeps that connection while it calls `inventory` and `payment`, which take connections from the
   same pool. With 20 workers checkout can hold at most 20 of 30 connections, so the system cannot
   jam. The deploy (workers 60, fan-out 4) pushes demand to ~90% of the pool; waiting keeps
   transactions open longer, which holds more connections, and checkout can now hold all 30.
   I chose this because the brief's own numbers rule out the simpler alternative: with 80 req/s,
   p99 ≤ 150 ms and 40% baseline utilization, a ×4 fan-out of one query cannot push open-loop
   demand above 30 connections, and with only 60 workers the pool queue could never get long
   enough to cause multi-second waits. Hold-and-wait is also what makes "raising timeouts makes it
   worse" and "fewer workers sheds load earlier" come out as the brief expects.
2. **Consequence: the incident is abrupt and near-total, not a slow climb.** The pool saturates
   within 5–10 s of the deploy and checkout errors go to ~98%. Most failures are immediate 503s
   from checkout's full queue (so checkout p50 drops to ~2 ms); the rest fail after 5–16 s. The
   brief's wording ("error rate climbs") suggests something more gradual. I did not soften it:
   a softer result would have required tuning numbers against the model.
3. **Timeouts.** `db.acquireTimeoutUs` = 5 s is "the 5 s timeout" (it matches the brief's log
   line). Service deadlines are longer (gateway 30 s, checkout 20 s, payment 8 s, inventory 6 s) so
   the acquire timeout is what requests hit first. With a 10 s checkout deadline the failures were
   deadline-driven and only 48 acquire timeouts occurred.
4. **Randomness is counter-based.** A draw is a pure function of `(seed, requestId, step path)`,
   e.g. path `checkout/place-order/order-tx/fulfil[0]/reserve[2]/inventory/reserve-stock`. No
   stream state exists, so nothing another request does can shift a draw. Span IDs are derived the
   same way, so the same logical span has the same ID in the recorded run and in every replay.
5. **Cancellation semantics.** When a service deadline fires or a parallel sibling fails, waiting
   work leaves its queue at once (service queue, pool queue, DB queue); a step already executing
   (compute, running query, external call) runs to completion and its handler then frees its
   worker/connection. A cancelled callee answers its caller immediately. So a child span can end
   after its parent; that is abandoned work, and it is marked `cancelled: true`.
6. **Gauges are point samples** (`pool_in_use`, `pool_wait_queue`, `db_active_queries`,
   `in_flight`, `queue_depth`), because the brief says metrics are _sampled_ and because
   window-averages lag: with averages, errors appeared one tick before "pool ≥ 95%". Cost: they
   are noisy. One baseline sample (T+7:30) reads 30/30 during a random burst, with no waits. Rates
   and percentiles cover the 5 s window. Exact time-averages are kept in `stats.timeAverages` for
   the Little's-law test only.
7. **Tracing is head-sampled at 5%** (deterministically by request ID); request-scoped logs follow
   the same sample, so every `traceId` on a log resolves to a stored trace. Metrics count every
   request. Reason: volume (48k spans / 14 MB instead of ~1M spans). Component logs (deploys,
   queue-full summaries, noise) are not sampled. Traces cut off by the end of the run are dropped
   whole (3 of ~5.4k for seed 42).
8. **Span shapes.** `db.pool.acquire` (wait, with capacity / in-use / wait-queue at request time),
   `db.query` (DB queue wait + execution, with `db.queue_wait_us` so the two can be separated),
   `db.transaction` (how long a connection was held), `queue.wait`, one server span per service
   call. There are no separate client spans and no network latency. Own compute is the remainder
   of a server span.
9. **Patches pin knobs.** `{target, to}` sets the knob for the whole run and stops scheduled
   changes from altering it (so `checkout.workers=20` means "the deploy happened but workers stayed
   20"). `{revert}` removes the change event entirely. `from` is not checked.
10. **Change events are declarative.** A diff key `k` on an event for service `s` changes knob
    `s.k` if that knob exists (`workers`, `queueLimit`, `timeoutUs`, `params.*`, `pool.capacity`,
    …); other keys (e.g. `version`) are informational.
11. **Red herring 1 is a real knob with no effect** (`inventory.timeoutUs` 6 s → 8 s), not an inert
    label. The test proves it: reverting it leaves every request, span and metric identical.
12. **No tsx.** Scripts and the CLI run on Node's built-in type stripping
    (`node --experimental-strip-types`), and `erasableSyntaxOnly` is on. Reason: tsx's `keepNames`
    wrapper made the engine ~2.5× slower.
13. **The engine is a class, not a function full of closures.** With closures, every run created
    new function objects and V8 call sites went megamorphic after 3 runs (4× slower from the 4th
    run in a process). Now a 15-minute scenario takes 0.7–1.1 s regardless of how many ran before,
    which Phase 4 sweeps depend on.

### Monotonicity: what holds and what does not

The brief's property ("increasing pool capacity never increases total acquire-wait time") is not
true unconditionally in this kind of system, and the tests say exactly where it is:

- **Pure queueing (transaction flattened, no deadlines, no shedding, DB unconstrained), capacities
  8…64:** mean wait per acquire, requests in system and completed requests are monotone at every
  step. _Total_ acquire wait is monotone from 22 connections up, where the same acquires are
  attempted. Below the offered load (~19) the pool throttles the system, requests are stuck
  upstream and issue fewer acquires (35k at 8 connections vs 77k at 22), so the total can be lower
  with a smaller pool (12 → 16 → 20: 12.3k s, 12.9k s, 13.3k s) although each acquire waits longer.
- **Scenario A with hold-and-wait:** total acquire wait falls along 30 → 64 → 120 → 200 (asserted).
  Inside the jammed range (20…50) it is not monotone step by step (30: 79.3k s, 35: 81.4k s): each
  extra connection admits another transaction that then queues several more acquires. Not asserted;
  recorded here.
- **DB-executor effect (tested separately):** as the pool grows past demand the wait moves to the
  DB executor queue (pool 30: 0 s, 64: 2370 s, 200: 3023 s of DB queue wait). With an unconstrained
  executor there is no wait anywhere.

### Assumptions

- The DB is one component named `db` in telemetry. The pool sits in front of it and is shared by
  all services (like a pgbouncer), as the brief specifies.
- Deploys take effect instantly (no rolling update); in-flight requests keep running.
- A query that is already executing cannot be aborted.
- Byte-identical output is guaranteed on the same Node/V8 version. `Math.exp/log/cos` are software
  implementations in V8, and durations are rounded to integer µs, so cross-version drift is
  unlikely but not tested.

### Known gaps

- **Scenario name leaks the diagnosis.** The output directory, `manifest.json` and
  `recording.json` say `pool-exhaustion`, and `recording.json` contains the full system model.
  Phase 2 must expose incidents to agents under neutral IDs and keep `recording.json` out of
  anything the investigator can read.
- **"A very large pool moves the bottleneck to the DB executor" is weaker than it sounds.** Once
  the pool exceeds demand, making it larger changes nothing more (64 and 200 behave alike). What
  the model shows is that the executor is the next limit (93% busy, standing queue, p99 397–467 ms
  vs 134 ms after a revert).
- `<service>.replicas` is a static knob (patchable, but a change event cannot alter it mid-run).
- `memoryLimit`, `cpuLimit` (Scenario D), `<queue>.consumers` (no message queue in the topology)
  and `cache.capacity` (no cache) are rejected by `applyPatches` with a reason.
- Replayed telemetry still shows the original diff on a change event even when a pin overrode part
  of it. Phase 4 should annotate that.
- `retryPolicy` lives on `call` steps and is unit-tested, but scenario A does not use it.
- Timeout status propagates upward unchanged (a payment deadline shows as 504 at checkout and at
  the gateway), so "which service timed out first" has to be read from span timing, not status.
- Scenario A's incident never recovers within the 15-minute run (no remediation is recorded).
- Workloads are stationary Poisson per request type; no bursts or daily shape.
