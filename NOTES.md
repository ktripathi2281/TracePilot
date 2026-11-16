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

---

## Phase 2 — Store, analysis library, Gate 2 (2026-11-15)

### What exists

- `packages/store`: SQLite telemetry store (`better-sqlite3`). Ingest validates every item through
  the telemetry schemas and writes atomically; queries for metric series, spans (by service, name,
  status, roots, time), whole traces, traces grouped by root start, logs (level, text, service,
  trace, time), change and pod events; `getEvidence` resolves any evidence ID; `exportTelemetry`
  round-trips exactly (same canonical hash).
- `packages/analysis`: pure analyzers over telemetry passed in:
  - `windows`: incident window inference
  - `anomaly`: anomaly detector
  - `precedence` + `onsets`: onset intervals and span-refined onsets
  - `graph`: dependency graph
  - `traces` + `attribution`: critical path and latency attribution
  - `saturation`: USE method
  - `holdwait`: hold-and-wait analyzer
  - `propagation`
  - `changes`: change correlation
  - `logs`: error-log bursts
  - `compare`: window comparison with confidence intervals
  - `timeline`
- `eval/src/pipeline.ts`: the whole analysis of one incident through the store only (what Phase 3
  tools will wrap). `eval/src/gate2.test.ts`: Gate 2 on seeds 42, 3, 7 plus two negative controls.
- `tracepilot sim run` now ingests into `<out>/telemetry.db` and writes the replay recording to
  `<out>/sim/<incidentId>.json`. It no longer writes telemetry dumps.
- Checks at commit time: format ✔, lint ✔, typecheck ✔, tests ✔ (264: schema 22, sim 74, store 13,
  analysis 62, CLI 8, lint rules 45, Gate 2 + controls 40).

### Gate 2 status: passes

All numbers below are computed by `analyzeIncident()` from the store, without any LLM. The first
three rows are the gate itself.

| Signal (seed 42)                        | Result                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool saturation precedes latency rise   | Metric level: `db pool_in_use` and `checkout latency_p99` begin within one tick, so **inconclusive** (as required). Span level: the pool is observed full in ≥ 50 % of acquires from 10:00.050 (49 ms resolution); checkout requests turn slow or failing from 10:01.789 (420 ms resolution), so db leads by **1.74 s**. Seed 3: 3.50 s, seed 7: 3.12 s.                                                         |
| Pool-acquire wait dominates attribution | Pipeline (all requests entering the gateway, incident from T+11:00): successes (423) pool_acquire **93 %**, failures (1021) pool_acquire **68 %**, query_exec < 1 % in both; baseline query_exec 76 %. Per route: checkout successes (19) 68 % / failures (974) 57 % (rest is queue wait for a checkout worker); stock successes (404) 99.5 % / failures (47) 100 %. Baseline per route: query_exec 75 % / 86 %. |
| DB execution time flat                  | Per statement, exec = duration − DB-queue wait. Ratios 1.005–1.106; every 95 % interval is inside ±25 %, so `flat`. No `query_exec_p95` anomaly.                                                                                                                                                                                                                                                                 |
| Hold-and-wait                           | Incident: pool 100 % used, 100 % of in-use connections idle-held, 99.4 % of transaction hold time spent waiting for further connections; holder checkout, waiters inventory and payment. Baseline: 40 % / 40 % / 0.1 %, so not detected.                                                                                                                                                                         |
| Propagation                             | Only origin: `db`, on all 4 failure paths, no precedence violation. Hops into db are ordered; same-request hops (gateway → checkout) stay inconclusive.                                                                                                                                                                                                                                                          |
| Red herring: inventory change `ev_1`    | Verdict **none**: inventory itself shows no anomaly, and the following upstream anomalies are explained by an earlier-or-equal anomaly in payment. Deploy `ev_2`: **correlated** (checkout error rate 5 s after).                                                                                                                                                                                                |
| Red herring: payment blip               | 10 anomalies, all `recovered` by 7:50; excluded from propagation ("recovered before the incident window started"); its log burst ended at 7:20.                                                                                                                                                                                                                                                                  |
| Persistence                             | Seed 42 has a 30/30 pool sample at 7:30 (in the store); it is not an anomaly. No pool anomaly before the deploy on any seed.                                                                                                                                                                                                                                                                                     |
| Negative control: no deploy             | Only a recovered episode; nothing saturated; no hold-and-wait; `ev_1` none.                                                                                                                                                                                                                                                                                                                                      |
| Negative control: DB 2× slower          | Exec `up` for every statement with ≥ 100 samples; `query_exec_p95` anomaly up; query_exec 78 % vs pool_acquire 12 %; no hold-and-wait. The pool hits its limit only in short episodes (saturated share < 0.5, mean utilization 0.84), and the analyzer reports them as such.                                                                                                                                     |

Mutation check run by hand: making the detector's persistence 1 fails 10 tests, including "does
not blame the inventory config change".

### Decisions (and deviations)

1. **Storage: better-sqlite3 13.2.0.** It compiled from source here (Windows, Node 24: no
   prebuild), so a C++ toolchain is needed where no prebuilt binary exists. It is allowed in
   `pnpm.onlyBuiltDependencies`. `node:sqlite` would avoid the native build but is still
   experimental; revisit if installation is a problem.
2. **Information boundary, enforced three ways.**
   - **Layout:** `telemetry.db` holds telemetry only. Recordings, scenario names and seeds live in
     `sim/<incidentId>.json`, read only by the simulator side.
   - **Lint:** the store may not import `node:fs`, so its only file is its own DB. Analysis may not
     do any I/O or import the store: it receives telemetry, so nothing else can reach it.
   - **Tests:** the store schema has no table or column for config, scenario, recording, workload,
     seed or truth. The raw DB file contains none of `pool-exhaustion`, `maxParallelQueries`,
     `requestTypes`, `disturbance`, `scenario`, while the private recording does contain them.
3. **Neutral incident IDs:** `in_` + base36 of the first 52 bits of the canonical SHA-256 of the
   telemetry (e.g. `in_rm6f1z3tf`). Ingest is idempotent (same telemetry → same incident).
   Evidence IDs are unique within an incident only; every lookup is scoped by incident, because a
   replay of a recording reuses the same span IDs.
4. **The store re-validates rows through Zod on the way out.** It is a boundary like any other.
   Cost: ~0.25 s to export 48k spans. Acceptable now.
5. **The incident record is derived from telemetry only:** time range, metric interval (most
   common gap), services, counts, hash. The store holds no "incident window": `inferIncidentWindows`
   finds the symptom at the entry service (owner of root spans), preferring error rate over p99.
   The baseline runs from 60 s warm-up to 60 s before the symptom.
6. **Anomaly detector = robust baseline + two-tier persistence + hysteresis + onset interval.**
   - **Strong rule:** 3 consecutive samples beyond 4 σ.
   - **Sustained rule:** 6 consecutive samples beyond 2 σ (Western-Electric style).
   - **Floors:** both thresholds are also bounded by a relative floor (25 % of the median) and an
     absolute floor per unit.
   - **Hysteresis:** an anomaly closes after 3 samples back inside 2 σ.

   Why two tiers: scenario A's point-sampled `pool_in_use` has a baseline range of 4–30 (σ ≈ 6),
   so a pool pinned at 30/30 for five minutes is only 3 σ per sample, and z = 4 alone missed it.
   Single spikes still cannot open an anomaly under either rule.

7. **Onsets are intervals, not points.** `onsetUs` is the first sample of the run that met a
   persistence rule. The interval reaches back to the last sample before the run, because noisy
   samples right next to a shift may be noise or the shift itself. The CUSUM change point
   (slack z/2) is reported inside the interval. A CUSUM-only onset put `in_flight` onsets at 9:40
   and 9:55, before the 10:00 deploy: false precision on noisy small-count gauges.
8. **Precedence:** `inconclusive` whenever |Δ| ≤ the coarser resolution, so two metric onsets one
   tick apart are a tie. On scenario A every metric-level comparison that matters is a tie;
   ordering comes only from spans.
9. **Span-refined onsets.**
   - **Signal:** a server span counts as bad when it is slow (exceeds at start + threshold) or
     failed (exceeds at its end). Slow alone never reaches a majority in an overload, because
     ~98 % of checkout requests fail fast with 503.
   - **Thresholds:** max(2 × baseline p99, p99 + 10 ms) per operation.
   - **db:** acquires that saw `in_use ≥ capacity`.
   - **Persistence:** ≥ 3 exceeding and a ≥ 50 % majority over max(one tick, the next 5
     candidates). The duration part rejected a 50 ms burst of full-pool acquires at 9:48; the
     count part lets sparse payment spans qualify.
   - **Resolution:** the gap to the previous sampled candidate.
   - **Acceptance:** a refinement replaces a metric onset only if it is no later than
     metric onset + metric resolution; otherwise sampling missed the start.
10. **Edge precedence uses the caller's operation, not the whole service.** Graph edges carry
    `callerOperations`. Without this, seed 3's gateway looked anomalous before checkout because its
    `stock` route (which never calls checkout) failed first.
11. **Latency attribution:**
    - **Method:** critical path (descend into the child that finished last; clip abandoned
      children to the parent). The categories queue_wait / pool_acquire / db_queue / query_exec /
      external / compute are exclusive and tile each request exactly.
    - **Held connection:** reported as an overlay (time inside a `db.transaction`, and what
      happened during it), not as a category.
    - **Outcomes:** successes and failures are reported separately.
    - **Downstream:** per service, `downstream` is the time spent waiting on services it called.
12. **Saturation:**
    - **Capacity:** worker and DB-executor limits are not exported as metrics, so capacity is
      inferred as the highest concurrency seen while a queue existed at the same instant.
      Otherwise the resource is `unknown-capacity`, never guessed.
    - **Status:** `saturated` needs 3 consecutive samples at ≥ 95 % with the queue above
      max(1, baseline p95).
    - **saturatedShare:** added after the slow-DB control showed short real episodes. It separates
      exhaustion (≈ 1) from episodes.
13. **Change correlation:** relation (self / downstream / upstream / unrelated), intervening change,
    and alternative origin (an anomaly no later than this one, in a dependency of the anomalous
    service that is unrelated to the changed service). `correlated` needs an unexplained anomaly
    in the changed service itself within 120 s.
14. **Window comparison uses a ~95 % interval on the log-ratio of medians** (SE of the median ≈
    1.2533 σ / √n). The verdict is `flat`, `up` or `down` only when the whole interval is on one
    side of the ±25 % band, else `inconclusive`. Without it, seed 7's `update-payment` (14 samples,
    ratio 1.275, interval [1.15, 1.42]) was called `up`.
15. **Log bursts:** active buckets merged across gaps of up to 3 quiet buckets, because request
    logs are trace-sampled and a real burst arrives scattered.
16. **Schema changes:**
    - `DependencyNode.kind`.
    - `DependencyEdge.kind` and `callerOperations`.
    - `DependencyGraph.entryServices`.
17. **Ground truth:** the red herrings got machine-readable fields (`kind`, `changeEventId`,
    `service`) so tests can use the file as the answer key.
18. **Gate 2 lives in `eval/`**, the only package allowed to see both the simulator and the store.
    `pipeline.ts` imports only store and analysis.

### Assumptions

- **Symptom detection:** the first pass of window inference uses robust statistics of the whole
  series, which describe normal behaviour only if the incident covers less than half of the data.
- **Instrumentation:**
  - Root spans mark entry services.
  - `db.transaction` spans mark held connections.
  - `db.pool.acquire` carries `db.pool.in_use` / `db.pool.capacity` at request time.
  - `db.query` carries `db.queue_wait_us`.
    Real OTel instrumentation would need these conventions (or adapters).
- **Database naming:** the database is the telemetry service `db`.

### Known gaps

- **Validation:** analyzer outputs are TypeScript types, not Zod schemas. Phase 3 must validate
  them at the tool boundary.
- **Scale:** the pipeline loads all spans of an incident into memory (48k spans: fine). Large
  incidents need aggregate queries in the store.
- **Capacity inference:** with 2 replicas, a queue on one replica can coexist with a free worker
  on the other, so the inferred worker capacity can be low.
- **Hold-and-wait inputs:** detection requires both views; without `db.transaction` spans only
  the metric view (idle-held connections) remains, and `detected` is false.
- **Fixed parameters:** change correlation uses a fixed 120 s lag, so slow-burn effects of a
  change would be missed.
- **Sparse operations:** operations with fewer than 20 baseline spans get no span refinement, and
  the dependency graph comes from sampled traces, so rare edges may be missing.
- **Flapping:** `db db_active_queries` (point samples) closes and reopens three times during the
  incident.
- **Migrations:** schema migrations are not handled (`CREATE TABLE IF NOT EXISTS` only); a schema
  change needs a fresh `telemetry.db`.
- **Generality:** Gate 2 covers one scenario on 3 seeds plus 2 controls. Scenarios B/C/D (Phase 6)
  will test whether the analyzers generalize beyond this pattern.

## Phase 3 — Agent layer, cassettes, CLI investigate (2026-11-16)

### Gate 3 status: NOT verified (needs one recorded live run)

Gate 3 is about a real model run: "`tracepilot investigate` on scenario A returns a diagnosis that
passes the verifier, rejects at least the slow-DB alternative with cited evidence, and does not
blame the red herrings."

- **No API credentials were available while building this phase**, so no live run was made and
  no cassette exists. Cassettes must be real recordings (brief §8), so none was written by hand.
- **The prompts and the protocol have never been run against a real model.** The first live run
  may show problems (a rule the model trips over, a prompt that needs work). Recording resumes
  where it stopped, so a failed attempt costs only the calls it made.
- `eval/src/gate3.test.ts` checks every clause of the gate by replaying
  `eval/cassettes/<incidentId>.json`. Without that file its 7 tests are **skipped**, and CI is
  green without Gate 3 being checked.
- What is verified instead, with a scripted test double in place of the model: the engine around
  the model (tools, ledger, hypothesis tests, skeptic rules, verifier, revision rounds, budget,
  cassettes) on real scenario A telemetry. That is not evidence about model behaviour.

To record (uses the API key in your environment; about 1.5 M tokens at most by the default
budget):

```bash
corepack pnpm run tracepilot sim run --scenario pool-exhaustion --seed 42 --out .data
```

```bash
TRACEPILOT_LLM=record TRACEPILOT_CASSETTE_DIR=eval/cassettes corepack pnpm run tracepilot investigate --incident in_rm6f1z3tf --out .data --stream
```

In PowerShell the second command is:

```powershell
$env:TRACEPILOT_LLM='record'; $env:TRACEPILOT_CASSETTE_DIR='eval/cassettes'; corepack pnpm run tracepilot investigate --incident in_rm6f1z3tf --out .data --stream
```

Then `corepack pnpm run test` runs the Gate 3 tests against the cassette. Commit the cassette if
they pass. If the investigation fails partway, fix the cause and run the same command again.
Changing a prompt or a tool invalidates the cassette (replay reports a miss); delete it and
record again.

### What exists

- `packages/schema`: `ledger` (FACT carries tool, args, finding key, value, evidence IDs, quoted
  and derived quantities, time), `hypothesis` (kinds, structured prediction checks), `diagnosis`
  (root cause with kind, causal steps with onset entry, recommendations with patch and
  `addresses`, follow-ups, verifier issues).
- `packages/agents`:
  - `tools/`: 14 data tools over the store and the Phase 2 analyzers, each returning **findings**
    (key, value, statement, evidence IDs, quantities); Zod-validated arguments.
  - `ledger.ts`: evidence ledger. FACTs are created only from tool findings.
  - `hypotheses.ts`: proposal validation (coverage rules, defining predictions, pairwise
    discrimination), the board that runs predictions and scores hypotheses.
  - `verifier.ts`, `grounding.ts`: deterministic pass. `confidence.ts`: rubric.
  - `investigate.ts`: orchestrator (investigator loop, skeptic sub-run, verifier loop with at
    most 2 revision rounds).
  - `llm/`: Anthropic provider, usage meter and budget, cassettes, request/response log, config.
  - `prompts/investigator.md`, `skeptic.md`, `verifier.md`, each with a rationale header that is
    stripped before sending.
  - `testing.ts`: `ScriptedLlm` and `protocolScript`, test doubles only.
- `packages/cli`: `tracepilot investigate --incident <id> [--stream] [--out <dir>]`. Saves
  `<out>/investigations/<id>.json` (ledger, hypotheses, skeptic report, verification rounds,
  usage) and appends `<out>/llm-logs/<id>.jsonl`. Exit 0 diagnosed, 1 inconclusive or failed,
  2 bad input (and, since the follow-up below, a diagnosis with unresolved verifier issues).
- Tests: agents unit tests (32), verifier on scenario A (33), orchestrator on scenario A (33),
  CLI investigate (10), Gate 3 replay (1 always on, 7 skipped).
- Checks at commit time: format ✔, lint ✔, typecheck ✔, tests ✔ (373 passed, 7 skipped: schema 22, sim 74, store 13,
  analysis 62, lint rules 45, Gate 2 + controls 40, agents 32, verifier 33, orchestrator 33, CLI 18,
  Gate 3 guard 1; skipped: the 7 Gate 3 replay tests).

### How the three rules are enforced

1. **Numbers never come from the LLM.**
   - The model cannot write a FACT. Tools produce findings; the ledger turns them into FACTs
     with IDs; the model only cites IDs.
   - Every number or time in model-written text (root cause, chain steps, rejection reasons,
     recommendations, follow-ups, unknowns, inferences, skeptic statements, the reviewer's
     reasons) must appear in the facts that text cites, after rounding and unit conversion.
     Otherwise: `ungrounded_number`.
   - Prediction outcomes, hypothesis status, the leading hypothesis and confidence are computed
     by the engine.
2. **No claim without evidence.** The deterministic pass re-checks every FACT in the ledger
   against the store (evidence exists, quoted fields match exactly) and re-runs its tool call
   with a fresh context (value, statement, derived quantities, time and evidence must be
   reproduced). Then it checks the draft.
3. **No hardcoded demo.** Prompts contain nothing about any system or scenario (tested).
   Cassettes record what answered them (`upstream: live | scripted`); a cassette recorded from
   the test double replays in mode `scripted` and is never shown as a recorded run. A test fails
   if a non-live cassette is ever put in `eval/cassettes/`.

### The four required verifier rejections

Each has its own tests in `eval/src/verifier.test.ts`, on real scenario A facts, by corrupting
one thing in an otherwise accepted diagnosis:

| Requirement                | Issue code                            | Cases tested                                                                                                                                                               |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fabricated IDs             | `missing_evidence`                    | Unknown ledger ID in every section; a FACT citing a span, metric point or change event not in the store; a patch reverting a missing change; a made-up tool or finding key |
| Mismatched numbers         | `value_mismatch`, `ungrounded_number` | Quoted field changed; derived quantity changed; statement edited; verdict flipped; time moved; a claim with a number its cited facts lack; a wrong patch `from`            |
| HYPOTHESIS used as premise | `hypothesis_as_premise`               | Hypothesis cited in any section; root cause resting only on its hypothesis; an INFERENCE with a hypothesis premise; the same laundered through a second inference          |
| Effect before cause        | `temporal_precedence`                 | The real chain reversed; a later onset blamed for an earlier event; a violation between non-adjacent steps; an undated step. Two onsets too close to order are NOT flagged |

### Decisions (and deviations)

1. **Predictions are structured, not prose.** A prediction is `{tool, args, findingKey, op,
expected}`. The engine runs the tool and compares. A hypothesis is rejected if any prediction
   is contradicted; supported if at least one is supported and the inconclusive ones do not
   outnumber the supported ones.
2. **Required hypotheses come from a coverage rule, not from the prompt.** If a connection pool
   is saturated in the incident window, a proposal must contain the kinds `pool_capacity`,
   `hold_and_wait` and `db_slow`, and these must be pairwise discriminated: a prediction on the
   same finding with conflicting expectations. The rule is triggered by telemetry, not by the
   scenario.
3. **Defining predictions.** A hypothesis of one of those kinds must include the prediction that
   defines the kind (hold-and-wait detected; connections not idle-held; DB execution not flat).
   Without this a "pool too small" label could be put on hold-and-wait predictions and come out
   supported.
4. **Structural root cause.** `rootCause.kind` is copied by the engine from the hypothesis that
   survived, and the root cause must cite a fact that supported one of its predictions. On
   scenario A the pool-capacity hypothesis is rejected by the idle-held finding, so "the pool is
   too small" cannot be published as the root cause. Recommendations carry a replay patch and
   `addresses: cause | symptom`; fixes that cannot be simulated (a code change) are `followUps`.
5. **Skeptic.** Separate prompt and context (it gets a brief, not the investigator's
   conversation). It must run at least 3 tool queries nobody ran before, and both its challenge
   to the leading hypothesis and its checks of the strongest alternative must cite a fact from
   those new queries. The alternative is an existing hypothesis or a new one, which the engine
   tests like any other.
6. **Temporal precedence** flags only certain violations: an effect that had begun before the
   earliest moment its cause could have begun (onset time minus resolution).
7. **Verifier LLM pass** runs only when the deterministic pass is clean. Its reasons are held to
   the number rule too.
8. **Confidence rubric:** share of supported predictions of the root hypothesis; −0.25 per
   refuting skeptic challenge; −0.10 each for a weakened challenge, violated precedence, no
   rejected alternative, no valid skeptic challenge; −0.15 per unresolved verifier issue (3 at
   most). High ≥ 0.75, medium ≥ 0.5.
9. **Budget default raised from 400,000 to 1,500,000 tokens.** The budget counts every token
   read or written, cached input included, and a tool loop resends its history each turn.
   400,000 would stop an ordinary investigation. This is an estimate; the first live run will
   show the real figure.
10. **API usage:** `tool_choice` is left at auto (the current models reject forced tool use),
    so a turn without a tool call is answered with a reminder, 3 times at most.
    Effort is `medium` by default. Prompt caching is on.
11. _(Changed in the Phase 3 follow-up: now off by default.)_ **Server-side model fallback is on by default** (`TRACEPILOT_LLM_FALLBACKS=off` disables
    it): if the requested model declines a request, the API may answer with another model. The
    usage record prices by the model that answered.
12. **Verifier model** defaults to the main model. The brief mentions Opus for the final pass;
    set `TRACEPILOT_VERIFIER_MODEL` for that.
13. **Cassettes:** one file per incident, keyed by SHA-256 of the canonical request. `record`
    replays what is already recorded and records the rest. `replay` fails on any miss and names
    the settings the cassette was recorded with.
14. _(Changed in the Phase 3 follow-up: exit code 2.)_ **Unresolved issues:** after 2 failed revisions the diagnosis is published with
    `unresolvedIssues`, the CLI prints them, and the exit code is still 0. Callers that need a
    verified diagnosis must check that list.

### Assumptions

- A model follows the tool protocol well enough that 4 rejected proposals, 4 rejected
  challenges and 2 revision rounds are sufficient. Untested.
- One investigation fits in the model's context window (45 investigator turns at most).
- The reviewer is the only role offered exactly one tool; the Gate 3 test uses that to read the
  verifier model back from the cassette.

### Known gaps

- **Gate 3** (above).
- _(Fixed in the Phase 3 follow-up.)_ **Number grounding is unit-blind and loose for small numbers.** A number passes if it matches
  any number in the cited facts after rounding, or after scaling by a power of 1000 or by 100. Found in testing:
  "a pool of 50 connections" passed because a cited fact contained a 49.7 ms resolution.
  A wrong small integer can slip through; the reviewer pass is the only other check.
- **The verifier does not judge prose without numbers.** "Connections were held" next to a fact
  that says otherwise is caught only by the LLM reviewer.
- **Coverage rules:** only the saturated-connection-pool rule exists. Other incident patterns
  get no required hypotheses yet (scenarios B to D, Phase 6).
- **Defining predictions exist for 3 kinds only.** The other kinds are free-form labels.
- **Cost figures** use a small built-in price table; unknown models report no cost.
- **The request log** keeps the newest message of each request, not the whole request.
- **Test time:** the verifier and orchestrator tests take about 40 s each, because every
  verification re-runs all tool calls.

## Phase 3 follow-up — verifier units, fallbacks, exit code (2026-11-16)

Three fixes before Phase 4, in their own commit.

1. **Numbers are matched as quantities, not magnitudes.** `grounding.ts` turns every cited fact
   into anchors, each with a source (`<evidenceId>.<field>` for a value quoted from telemetry,
   `<factId>.<name>` for a derived value or a number printed in the statement), a dimension
   (time, clock, share, rate, plain) and an optional statistic label (p50, p95, p99, mean, max,
   min, read from the words just before the number). A number in model-written text is grounded
   only by an anchor of the same dimension and, when both name one, the same label, at the
   precision the text wrote it. Units convert within a dimension (7510 ms = 7.51 s), never across.
   Patch `from` values are checked the same way (knobs named `...Us` are durations).
   - Rejected now, accepted before: "a pool of 50 connections" next to a cited 49.7 ms; "the p95
     hold time was 7.51 s" when the fact says p50 7.51 s, p95 8.01 s; "7.51 ms" for 7.51 s;
     "30%" for a capacity of 30. Tests in `eval/src/verifier.test.ts` ("2b") on real facts and
     in `agents.test.ts`.
   - The verifier also checks each quoted quantity's unit against the stored item: metric values
     are in the metric's unit, timestamps and durations in µs, `..._us` / `...Us` attributes and
     diff values in µs, everything else a count. Change-event diff quantities now carry `us` or
     `count` instead of a generic `value`.
   - Still loose: a number without a label matches any anchor of its dimension, so a bare count
     that happens to equal another count in the cited facts passes. Labels are read only from a
     fixed list of statistic words.
2. **Server-side fallback is off by default** (`TRACEPILOT_LLM_FALLBACKS=on` enables it; the
   values are now `on|off`). Every answer records the model that produced it: cassette entries
   have `answeredBy`, the investigation record has `llm.answeredBy`, and a response from a model
   other than the requested one adds a warning.
3. **`tracepilot investigate` exits 2 when a diagnosis is published with unresolved verifier
   issues**, and says on stderr that it is not verified. Exit 2 therefore means "bad input" or
   "not verified"; the message tells which.

## Phase 4 — Counterfactual replay, sweep, CLI (2026-11-16)

### What exists

- `packages/replay` (new package): `Replayer` runs an incident's recording through the same
  simulator with patches and compares it with the original; `sweep` runs a range of one knob;
  `replayRecommendations` replays each recommendation of a diagnosis and compares them;
  `readRecommendations` reads them from a saved investigation. The simulator-side recording file
  (`<out>/sim/<id>.json`) moved here from the CLI.
- `tracepilot replay --incident <id> [--patch t=n]... [--revert ev]... [--variant v:svc]...`,
  `tracepilot replay --incident <id> --diagnosis <investigation.json> [--recommendation rc_n]...`
  and `tracepilot sweep --incident <id> --param <target> --range a:b:step`. Results go to
  `<out>/replays/`. `--json` prints the result instead.
- Simulator: change events in replayed telemetry carry `pinned` (diff keys a patch held fixed,
  with the value kept), and the deploy log line says so. A structural model variant,
  `release-connection-before-calls` (the stretch item), is implemented in the engine.
- Tests: Gate 4 on scenario A (21), CLI replay and sweep (11), replay unit tests (5), schema and
  knob tests for the variant (3), engine test for the pin annotation, lint-rule cases for the
  new package (10).
- Checks at commit time: format ✔, lint ✔, typecheck ✔, tests ✔ (429 passed, 7 skipped: the Gate 3
  replay tests, still waiting for a recorded run).

### Gate 4 status: passes

All numbers are simulator output for scenario A, seed 42, printed by the CLI. Requests are those
that finished in the incident window (T+10:00 – T+15:00, inferred from the recorded telemetry).

| Replay                                     | Verdict  | Failed | Error rate | p99     | New pressure (saturation analyzer)        |
| ------------------------------------------ | -------- | ------ | ---------- | ------- | ----------------------------------------- |
| original                                   |          | 24726  | 69.2 %     | 16.03 s | db.pool, checkout.workers                 |
| `revert ev_2` (rc_1, cause)                | resolves | 0      | 0.0 %      | 129 ms  | none                                      |
| `db.pool.capacity=64` (rc_2, symptom)      | resolves | 0      | 0.0 %      | 356 ms  | db.executor (91.5 % busy, queue mean 8.4) |
| `release-connection-before-calls:checkout` | resolves | 0      | 0.0 %      | 412 ms  | db.executor                               |
| `checkout.workers=20`                      | improves | 4912   | 13.7 %     | 1.01 s  | none                                      |
| `db.acquireTimeoutUs=15000000`             | worsens  | 30267  | 85.0 %     | 20.00 s |                                           |

The tests assert the qualitative outcomes (verdict and direction), not these exact figures.

- **The recommended patch improves the metrics:** both recommendations of the scripted
  diagnosis stop every failure. The cause patch does it with no new bottleneck and a lower p99;
  the symptom patch moves the pressure to the DB executor (2370 s of DB queue wait vs none). The
  comparison says so in a finding built from the numbers.
- **Identity replay is exact:** every `Replayer` first replays the recording without patches
  and refuses to report anything unless the telemetry hash equals the recorded one. A patch that
  sets a knob to its recorded value (`db.pool.capacity=30`) gives the identical hash.
- **The sweep shows a sensible knee** (`db.pool.capacity` 20…120 step 10):

  | pool | errors | p99     | DB queue wait | under pressure                         |
  | ---- | ------ | ------- | ------------- | -------------------------------------- |
  | 20   | 70.2 % | 10.46 s | 0             | checkout.workers, db.pool              |
  | 30   | 69.2 % | 16.03 s | 0             | checkout.workers, db.pool              |
  | 40   | 55.6 % | 15.96 s | 154 s         | checkout.workers, db.executor, db.pool |
  | 50   | 33.1 % | 13.66 s | 770 s         | checkout.workers, db.executor, db.pool |
  | 60   | 0.0 %  | 351 ms  | 2234 s        | db.executor                            |
  | 80   | 0.0 %  | 374 ms  | 2695 s        | db.executor                            |
  | 120  | 0.0 %  | 407 ms  | 2957 s        | db.executor                            |

  Knee and "resolves from" at 60; the DB executor comes under pressure from 40. Past the knee a
  larger pool buys nothing and p99 creeps up as the executor queues: the brief's "very large
  pool moves the bottleneck to the DB executor".

### Decisions (and deviations)

1. **A new package, `packages/replay`.** The brief's layout has no home for replay: it needs
   the simulator (so not analysis, store or agents) and the saturation analyzer (so not sim, to
   keep the simulator free of analysis code). The server (Phase 5) can use it. Lint: agents,
   store, analysis and web may not import it (it carries the recording); it may not import eval.
2. **Every number is simulator output.** Headline figures come from request outcomes and the
   simulator's counters of the two runs; side effects from the Phase 2 saturation analyzer run on
   each run's telemetry. The telemetry store is not read for any number (only to check that it
   holds the same telemetry as the recording). A test recomputes the figures from a direct
   simulator run.
3. **Comparison windows are inferred from the recorded telemetry** with the Phase 2 window
   inference, not taken from the scenario definition, and are the same for both runs.
4. **The symptom** (for "time degraded" and the verdict) is a 5 s bucket where entry requests
   fail above max(1 %, baseline + 1 point) or p99 exceeds max(1 s, 5 × baseline p99), or nothing
   finishes. Thresholds come from the original run's baseline and are applied unchanged to the
   replay.
5. **Verdict rubric:** `resolves` = at most 2 degraded buckets (the moment of the change) and
   errors under the threshold; `worsens` = more failures or degraded time, or a worse p99
   without fewer failures; `improves` = fewer failures or less degraded time and p99 not worse;
   `no_change` = every headline delta within 1 %; else `mixed`. The 2-bucket allowance was added
   after pool 64 showed one 5 s degraded bucket right at the deploy.
6. **Side effects:** a resource the analyzer finds saturated or busy in the replay but not in the
   original is a `new_bottleneck`; the reverse is `relieved`; a queue that appears where there
   was none is `queue_formed`; a service with more errors is `more_errors`.
7. **Pinned knobs:** `ChangeEvent.pinned` (optional) lists the diff keys a patch held fixed and
   the value kept. Absent in recorded telemetry, so identity hashes are unchanged. The recorded
   diff is kept as it was.
8. **Diagnosis files:** `replay --diagnosis` reads the saved investigation, checks that it is
   for the same incident, and replays each recommendation on its own (or the ones named with
   `--recommendation`). A diagnosis with unresolved verifier issues is replayed with a note.
9. **The notice** ("Simulated from a model of the system. Not a guarantee of production
   behavior.") is a field of every ReplayRun, comparison and Sweep, and the CLI prints it first
   and last.
10. **Results are saved as JSON summaries** (`<out>/replays/rp_<hash>.json`), not as telemetry.
    Replayed telemetry is never ingested into the store, where it would look like a new incident
    to the investigator. The summaries keep the chart series (11 metrics per service).
11. **Model variant (stretch): `release-connection-before-calls`.** A new patch form
    `{ variant, service }`. The engine runs a marked transaction as segments: DB work holds a
    connection, every other step (calls, parallel branches, fan-out) runs with none held, and
    the DB work after it acquires a fresh connection. Child step paths are those of the plain
    transaction, so every random draw is identical (tested). On scenario A it resolves the
    incident with the deploy in place, and the hold-and-wait analyzer no longer detects
    hold-and-wait in the replayed telemetry. The transaction is no longer atomic; the replay
    models the timing, not the correctness, of that change.
12. **The investigator prompt (v2) lists the variant** as a patch form, so a model can propose
    the structural fix as a replayable patch. Listing it hints at what the replay engine can
    model; it is in the tool schema anyway. Any recorded Phase 3 cassette is invalidated by this
    prompt change (none exists yet).

### Assumptions

- The recording on disk and the simulator are the same versions that produced the stored
  telemetry; identity replay checks it.
- Requests are compared by when they FINISHED, so a replay that makes requests slower shifts
  some of them out of the window.

### Known gaps

- **Only simulated incidents can be replayed** (they need the recording). Real telemetry would
  need a fitted model.
- **Replay speed:** about 1.2 s per run plus the identity run; the 11-point sweep takes ~14 s.
  Runs are sequential.
- **Latency p50 can look worse after a fix** (1.8 ms → 105 ms with pool 64) because, in the
  original, most requests failed fast. The table reports it as measured; p99, failures and
  goodput are the meaningful figures.
- **Sweep knee** is a fixed rule (error rate within 0.5 points of the best, p99 within 10 % of
  the best); it is not a fitted curve.
- **The verdict thresholds** (1 %, 1 s, 5 × baseline p99, 2 buckets) are fixed, not
  configurable.
- **No LLM narration** of replay results yet (the brief allows it with returned numbers only).

## Phase 4 follow-up — prompt grammar, bare counts, exit codes, windows (2026-11-16)

A small commit before Phase 5.

1. **The investigator prompt (v3) names no structural fix.** The patch grammar lists the variant
   form generically, `{ "variant": "<name>", "service": "<service>" }`, with example names that are
   not the modeled one. The schema's `MODEL_VARIANTS` now lists six common structural fixes
   (async-downstream-calls, batch-queries, cache-reads, circuit-breaker,
   dedicated-connection-pool, release-connection-before-calls); the simulator models only
   `release-connection-before-calls` (`MODELED_VARIANTS`). Replaying another variant is refused
   with a reason, and a diagnosis replay reports that recommendation as `not_replayable` while
   the others still run. A test checks that no prompt names the modeled variant or describes it
   ("release the connection", "before calls other services"). The `submit_diagnosis` tool schema
   still lists all six names as an enum; that is the grammar, and the decoys keep it from pointing
   at one.
2. **Bare counts must name their subject.** A number without a unit is grounded only by an anchor
   that shares a content word with it: the words around the number in its clause, against the
   words around the anchor in the fact statement plus the fact's finding key and the evidence
   field or derived-quantity name. "The pool capacity was 30" passes against a pool fact that says
   "capacity 30"; "30 requests failed" and a lone "30" do not. One test text changed as a result
   ("All 30 connections" became "All 30 pool connections"): synonyms are not modeled, so a count
   has to use a word the fact uses. Units and statistic labels work as before.
3. **Bad input has its own exit code, 64** (EX_USAGE), for every command. 0 done, 1 failed,
   2 diagnosis published but not verified (investigate only), 64 bad input. The usage text lists
   them.
4. **Replay, diagnosis comparison and sweep output print both analysis windows** (baseline and
   incident, inferred from the recorded telemetry, the same for every run). Sweeps now record
   `windows` too.

## Phase 5 — Server and web UI (2026-11-16)

### What exists

- `apps/server` (Hono): REST over the telemetry store and the saved records, SSE for running an
  investigation, replay and sweep run in-process, and the built UI at `/`.
  - Telemetry: incidents, overview (headline p99 / failed requests / ok throughput, per-service
    health, graph edges, changes), timeline, service detail (metric series, slowest sampled traces),
    trace, evidence by ID.
  - Investigations: the saved record with its source label; `POST …/investigation/run` streams a new
    one (`fixture` = scripted test double, `env` = the server's TRACEPILOT_LLM setting) and saves it.
  - Replay: knob catalog, replay, replay-the-diagnosis, sweep, saved replays.
- `apps/web` (React 19, Vite 8, Tailwind 4, React Flow for the service graph, uPlot for charts),
  hash-routed, four views: Overview, Incident, Investigation, Replay lab.
- `tracepilot serve [--out] [--port]` (default 127.0.0.1:4318); `pnpm run web:build`, `web:dev`
  (Vite on :5173, proxying `/api`).
- Tests: server API and information boundary (10), UI smoke test in a real browser (5).
- Checks at commit time: format ✔, lint ✔, typecheck ✔, tests ✔ (449 passed, 7 skipped: the Gate 3
  replay tests, still waiting for a recorded run).

### Smoke test status: passes

`eval/src/ui-smoke.test.ts` builds the UI, starts the server on scenario A with a saved
scripted-fixture investigation and no API key, and clicks through:

1. **Overview:** the three headlines (p99, failed requests, throughput with baselines); the graph
   nodes with health (checkout failing, db degraded); the changes list.
2. **Incident:** clicks the checkout node in the graph; two change markers and the anomaly markers
   on the timeline; picks the deploy marker; the service's charts; opens the slowest trace and
   finds `db.pool.acquire` in the waterfall.
3. **Investigation:** source badge `scripted fixture`; three hypotheses (hold-and-wait supported,
   pool-too-small and DB-slow rejected); diagnosis and verifier; an evidence chip opens the panel
   with the stored span or metric.
4. **Replay lab:** follows "replay →" from the cause recommendation (revert pre-ticked); `resolves`
   with 0 failed requests; sets pool 64 and sees the DB executor side effect; sweeps 40–80 and gets
   knee 60; the notice is still on screen after scrolling to the sweep.

It also fails on any page error or console error. The browser is the installed Edge or Chrome
through `playwright-core` (no browser download); `TRACEPILOT_BROWSER` overrides it, and
`TRACEPILOT_SMOKE_SHOTS=<dir>` keeps a screenshot of each view.

### Decisions (and deviations)

1. **The information boundary is enforced in the server, and tested.** No route reads the data
   directory's `sim/` except through the Replayer, whose outputs are simulator-computed summaries;
   eval is never imported (lint). Static serving covers only the built UI's `assets/`; every other
   path returns `index.html`. The server test collects every response it received (GET, POST, SSE)
   and checks that none contains simulator-config or ground-truth markers (scenario name,
   workload, recording, executor size, disturbance text, ground-truth keys), and that no
   traversal path reaches the recording.
2. **Knob current values come only from telemetry.** The replay lab shows a current value for the
   pool (from the `pool_capacity` metric) and for knobs a change event's diff names (checkout
   workers 60, inventory timeout 8 s). Values only the simulator config has (gateway workers,
   acquire timeout) are left blank.
3. **Investigation source** is labelled from the record: `scripted fixture` (test double),
   `recorded` (replayed cassette) or `live` (live or record mode). A fixture run records its model
   as `none (scripted fixture)`, not the configured model name.
4. **The UI computes no numbers.** Headlines and health come from the server (metrics of the
   entry services: median p99, Σ error_rate × request_rate × tick, median ok throughput); replay
   figures are simulator output. Health thresholds (failing ≥ 5 % errors; degraded ≥ 1 % or p99
   ≥ 3 × baseline; the database by pool saturation) are fixed.
5. **Web imports only types from the server** (`@tracepilot/server/api-types`); a lint rule
   (`@typescript-eslint/no-restricted-imports`, type imports allowed) stops runtime imports of the
   server, agents, store or analysis. Responses are not Zod-validated in the browser; the server
   builds them from validated data.
6. **The notice** is a sticky banner at the top of the replay lab, on screen at any scroll
   position, and every replay/sweep payload still carries it.
7. **Investigations stream over SSE** as the engine reports events; the request is a POST, so the
   UI reads the stream with `fetch` rather than `EventSource`.
8. **Replays and sweeps run in the server process**, synchronously (≈1.5 s per replay, ≈7 s for a
   5-point sweep, ≈14 s for 11 points). Replayers are cached per incident.
9. **Hash routing** (`#/<view>/<incident>`), so the server needs no route table for the UI.
10. **The smoke test drives a real browser** rather than jsdom: React Flow and uPlot need layout
    and canvas. GitHub's Ubuntu runners have Chrome installed, which the test finds by channel.

### Known gaps

- **Replays block the server** while they run (no worker thread); one user at a time is assumed.
- **One investigation per incident** is kept (`investigations/<id>.json`); a new run replaces it.
- **The variant dropdown says which variants are modeled.** That is the engine's capability,
  shown to the human; the prompts still name none.
- **Health and headline thresholds** are fixed rules, not configurable.
- **Trace list** shows the 12 slowest sampled traces through a service in the incident window
  only.
- **The bundle is ~500 kB** (React Flow and uPlot); no code splitting.
- **No auth**, by design (brief §12 non-goal): bind to localhost.

## Phase 6 — README, eval harness, scenarios (2026-11-16)

### (a) README

Rewritten around the architecture (simulator side vs investigator side, package table), the three
rules as enforced, the synthetic-data caveat, non-goals and a 2-minute demo script that needs no
API key. The demo uses the scripted fixture and says so; step 3b records a real run.

### (b) Eval harness

- `eval/src/harness.ts` and `tracepilot eval [--scenario] [--seed] [--investigator
auto|scripted|cassette|live] [--json] [--write-readme]`. Each run simulates the scenario into an
  in-memory store, investigates, scores and replays.
- **Scores**, all deterministic: root cause (the diagnosis's `rootCause.kind` is one the ground
  truth accepts, and the causal chain or the cause recommendation cites the culprit change);
  evidence validity (ledger FACTs that re-verify against the store); hallucinations (an
  independent deterministic re-verification of the PUBLISHED diagnosis: fabricated IDs, mismatched
  or ungrounded numbers, hypotheses as premises; drafts caught in revision are counted apart); red
  herrings not blamed (no herring fact behind the root cause, chain or a cause fix, and no revert of
  a herring change); skeptic challenged; and the recommended patch (first `cause`
  recommendation, else the first) resolving or improving the incident in replay. Pass = all six.
- **Who played the model is part of every row.** `auto` uses a recorded live cassette when one
  exists for that scenario and seed, otherwise the scripted fixture plus a "model: not run" row.
  There is no cassette yet, so every result in the README is the scripted fixture: it tests the
  engine, not a model.
- **Ground truth** gained `rootCause.hypothesisKinds` (the kinds that name the mechanism); the
  schema is in `eval/src/ground-truth.ts`.
- **The harness is tested on wrong answers**: a diagnosis that blames the red-herring change, a
  root cause of the wrong kind, a number published after two failed revisions (1 hallucination, 2
  caught in revision), and an investigation that fails (a failed row, not a crash).
- **The README table is checked**: a test re-runs the harness for every scenario and seed in the
  README table and requires the same scripted rows (cells compared without Prettier's padding).
- Results on scenario A, seeds 42, 3 and 7: pass on every score (100 % of 96–97 facts valid,
  0 hallucinations, revert ev_2 resolves).

### (c) Scenario D: bad-rollout-oomkill

**What exists**

- Pod lifecycle model in `sim` (`ServiceModel.pods`): each replica is a pod with memory = base +
  per-request × requests in progress. Over the limit it is OOMKilled: its in-flight requests fail
  (502), its queued ones too (503), it restarts after an exponential back-off (10 s doubling to
  160 s; CrashLoopBackOff from the second consecutive kill; reset after 10 min up), and takes
  traffic again 5 s after restarting. Only ready pods receive traffic; with none, requests get 503
  at once. Pod events (OOMKilled, CrashLoopBackOff, Restarted, Started) and metrics
  (`replicas_ready`, `pod_restarts`, `memory_working_set`) are emitted only for services with a
  pod model, so scenario A's telemetry is byte-identical to before (identity tests unchanged).
- Knobs: `<service>.memoryLimit` (patchable) and `<service>.memoryPerRequest` (what a rollout
  changes). `memoryLimit` on a service without a pod model is refused with that reason.
- `scenarios/bad-rollout-oomkill.ts`: the same topology as A; checkout on 3 pods × 6 workers;
  rollout ev_2 at T+10:00 raises memory per request 6 → 40 MiB (limit 512 MiB). Red herrings: a
  payment timeout change (ev_1, T+6:00), a 20 s ×4 slowdown of the stock-reservation query
  (T+7:30), an inventory queue-limit change after the onset (ev_3, T+10:40).
- `eval/ground-truth/bad-rollout-oomkill.json` with root cause, causal chain, discriminating
  evidence, red herrings and the MEASURED replay outcomes.
- Investigator side (generic, naming no fix): `get_pod_events` tool (findings
  `pods.<service>.<window>.oom_killed | crash_loop | disrupted`), pod events on the timeline (and
  a "pods" lane in the UI), hypothesis kind `resource_limit` with its defining prediction
  (`oom_killed` or `disrupted` true). The investigator prompt (v4) gained one line describing
  `resource_limit` generically. Its knob list was NOT extended with `memoryLimit`: that would name
  D's fix. The patch grammar (tool schema) already contains it.
- Tests: pod lifecycle micro tests (7), scenario D (14): simulator characteristics, analyzer
  signals without an LLM, replays.

**Measured (seed 42; seeds 3 and 7 agree unless noted)**: first OOMKill 1.6 s after the rollout,
all three pods killed, 15 OOMKills and 12 CrashLoopBackOffs, `replicas_ready` 0 for most of the
incident, 66 % of entry requests failed; pool utilization 3.2 % (status ok), hold-and-wait not
detected, DB execution flat. Replays: revert ev_2 → resolves; memoryLimit 768 MiB or 1 GiB →
resolves; pool 64 → same error rate; revert ev_1 or ev_3 → no change.

**Where the simulator disagrees with the brief (recorded, not tuned away)**

1. **"Adding replicas only delays the failure"**: the model does not show that. 4 replicas
   resolve it on seeds 42 and 3 and leave 34 % errors on seed 7; 6 replicas leave ~4 % errors on
   seeds 42 and 3 (a queue forms) and resolve on seed 7. More pods lower each pod's concurrency
   below the kill threshold; whether a burst still trips one is seed-dependent. A model where
   memory also grows with time or queued requests could show the brief's behavior; this one does
   not, and I did not add such a mechanism to get the expected answer.
2. **"Latency climbs, errors follow"**: errors rise WITHOUT latency climbing first. A pod is
   killed the moment it processes six requests, which is exactly when its workers are all busy,
   so no queue forms before the kill; failures are fast (502/503), and entry p99 even drops.
3. **Calibration finding**: with 3 pods × 20 workers, the DB-latency blip alone set off scenario
   A's hold-and-wait jam (60 checkout workers can hold every connection) and the pool stayed jammed
   from T+7:30. That was scenario A hidden inside D by my configuration. D uses 3 × 6 workers (18,
   under the 20 that keep the pool from jamming, as in A's baseline). The same mechanism is why
   adding replicas in D can turn the blip into a jam: replicas add checkout concurrency.

**Analyzer changes and limitations exposed by D**

- **Fixed: propagation counted a node receiving less work as failing.** In D the database's
  request rate drops (checkout is down), and `analyze_propagation` named db as the origin. Now
  only degrading signals (errors, latency, queues, concurrency or resource use up; ready replicas
  down) mark a node; load drops are listed as `less_work` exclusions. Scenario A's results are
  unchanged. Excluded-anomaly finding keys now include the onset
  (`propagation.excluded.<service>.<metric>.<onsetUs>`): the verifier caught two findings sharing
  a key once an anomaly could be excluded for two reasons.
- **Known limitation: propagation names payment as the origin in D.** When a checkout pod dies,
  its in-flight payment calls are cancelled, and cancellations count in payment's error rate. The
  path api-gateway → checkout → payment ends at payment, and its onset is within one metric tick
  of checkout's, so precedence cannot rule it out. The pod-event tool is what discriminates.
- **Change correlation marks the payment config change (ev_1) correlated**: the DB blip 95 s
  later raises payment latency within the 120 s lag. It reports correlation, not cause; the eval
  checks whether a diagnosis blames it.
- **Replay fix**: the degraded-time count included a 1 µs sliver at the end of the window as a
  bucket where "nothing finished". Only full buckets count now.

**Eval**: the scripted fixture fails D on every seed ("no fact with key propagation.onset.db"):
its fixed procedure assumes a connection-pool incident. That is the expected result for a test
double; D's investigation needs a model, and no model run is recorded.

### (d) Scenario B: slow-dependency-retry-storm

**What exists**

- `scenarios/retry-storm.ts`: the same topology. This checkout version releases its DB connection
  around downstream calls (no hold-and-wait) and retries payment up to 3 times (100 ms back-off,
  doubling). payment has a 1.5 s deadline and a fraud-screening step (an external call, 0.9 s
  median) that the payment v3.2.0 deploy (ev_2, T+10:00) switches on through a step-count
  parameter. Red herrings: scenario A's inventory timeout change (ev_1) and payment-provider blip
  (T+7:00, the same service as the real cause).
- `eval/ground-truth/slow-dependency-retry-storm.json` with the measured replay outcomes. Root
  cause kind `downstream_slow`.
- `get_retry_stats` tool and `analyzeRetries` analyzer: per service, the share of requests it
  received that were retries (`retries.<service>.<window>.amplified`, true at ≥ 5 %). No prompt
  change: no new hypothesis kind was needed.
- Tests: 13 (simulator characteristics, analyzer signals, replays).

**Calibration, recorded as it happened**

1. First configuration (checkout 20 workers, payment 2 × 64): checkout's workers capped the load
   reaching payment (payment's request rate fell from 80/s to 20/s), so retries amplified almost
   nothing; raising payment's deadline removed the retries and errors barely moved (78 % → 76 %).
2. To give retries room to amplify I set checkout to 60 workers (safe from A's jam, since this
   version does not hold connections across calls) and payment to 2 × 40. That is the shipped
   configuration. **It still is not a retry storm**: payment never runs out of workers (≤ 64 of
   80), retries are ~15 % of payment's requests (amplification 1.18), and checkout's workers are
   the bottleneck. I stopped there rather than search for parameters that produce the brief's
   picture.

**Measured (seeds 42, 3, 7 agree)**: 24 % of entry requests fail, p99 about 3.8 s; checkout
workers saturated (queue full); payment, the pool (17 %) and the DB are fine; stock requests
unaffected. Propagation origin: payment (span onsets: payment, then checkout, then the gateway,
within half a second of the deploy). Replays: revert → resolves; payment deadline 3 s →
improves (19 % errors, almost no retries, still slow); payment workers ×4, pool 64, revert ev_1
→ no change; **checkout workers 60 → 120 → worsens (47 % errors)**: checkout now sends enough
retries to saturate payment (56 % of payment's requests are retries, amplification 2.3). The
retry storm the brief describes appears exactly when the visible symptom (checkout out of workers)
is "fixed" by adding workers.

**Where the simulator differs from the brief**: the brief's B is a retry storm; in this model the
storm is latent (it needs more caller concurrency) and the incident as recorded is a slow
dependency exhausting the caller's workers, with retries as a minor amplifier.

**Eval**: the scripted fixture fails B on every seed, as it does D. All three scenarios still need
a recorded model run.

### (e) Scenario C: cache-hit-rate-drop

**What exists**

- Cache model in `sim`: a `cache` step (cache-aside) and a shared cache tier (`model.cache`,
  knob `cache.capacity`). A lookup hits with probability entries / key space, where the key space
  is a service parameter (`keySpaceParam`); each miss runs the backing steps and fills one entry
  up to the capacity; a change of the key-space parameter (a new key format) empties the cache.
  The run starts warm. Hit/miss draws come from the request's own random stream (common random
  numbers hold). Spans `cache.get` (attribute `cache.hit`) and the metric `cache_hit_ratio` are
  emitted only by services with a cache step: A, B and D are byte-identical to before.
- `scenarios/cache-hit-rate-drop.ts`: the same topology; inventory's stock lookups go through a
  20,000-entry cache over 21,000 keys (about 95 % hits; a miss reads stock and prices); a heavier
  stock read rate (300/s) and a 16-query database; checkout releases its connection around calls.
  inventory v1.9.0 (ev_2, T+10:00) changes the key to include warehouse and customer segment
  (400,000 keys). Red herrings: A's inventory timeout change (same service) and provider blip.
- `analyzeCaches` and the `get_cache_stats` tool (`cache.<service>.<window>.degraded`, true when
  the median hit ratio fell 20 points or more, dated at the first sample below), hypothesis kind
  `cache_degradation` with its defining prediction, one generic prompt line (v5). Propagation
  counts a falling hit ratio as degrading. No prompt names a fix; `cache.capacity` is not in the
  prompt's knob list.
- `eval/ground-truth/cache-hit-rate-drop.json` with the measured replay outcomes; tests: cache
  micro tests (5), scenario C (11).

**Measured (seeds 42, 3, 7 agree)**: hit ratio 95 % → 2–5 % from the first sample after the
deploy; the DB executor saturated (16/16, queue ~14) and the pool full (30/30) of connections
that are executing or queued, not idle-held; per-query execution time flat; stock p99 48 → ~260 ms;
checkout p99 ~1.3 s with ~27 % errors (worker exhaustion); 5.7 % of all entry requests fail.
Replays: revert → resolves (relieves pool, executor and checkout workers); cache 500,000 →
improves slowly (5.7 % → 3.6 %, p99 still ~1.1 s: the new keys warm one miss at a time);
pool 64, inventory workers ×2, revert ev_1 → error rate unchanged.

**Where the model is a simplification**: keys are accessed uniformly, so a cold cache warms
linearly and a larger cache helps slowly. Real key popularity is skewed (a few keys get most
reads), which makes caches warm much faster; with skew, raising the capacity would likely
recover more within the window. Not modeled.

**Analyzer behavior worth knowing**: propagation names db as the origin (the failure shows
there; the cause is upstream in inventory's cache). The connection-pool coverage rule fires
(the pool is saturated), and "pool too small" is NOT refuted by telemetry here: its defining
prediction (connections busy, not idle-held) holds. What refutes it is the replay (pool 64
changes nothing) and the cache evidence; a diagnosis must propose `cache_degradation` to name the
mechanism.

**Eval**: the scripted fixture completes on C and recommends the right fix (revert ev_2, which
resolves), but names hold-and-wait as the mechanism: scored as a root-cause miss and an overall
fail. The harness does not give credit for a fix found for the wrong reason.
