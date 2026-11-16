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
  2 bad input.
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
11. **Server-side model fallback is on by default** (`TRACEPILOT_LLM_FALLBACKS=off` disables
    it): if the requested model declines a request, the API may answer with another model. The
    usage record prices by the model that answered.
12. **Verifier model** defaults to the main model. The brief mentions Opus for the final pass;
    set `TRACEPILOT_VERIFIER_MODEL` for that.
13. **Cassettes:** one file per incident, keyed by SHA-256 of the canonical request. `record`
    replays what is already recorded and records the rest. `replay` fails on any miss and names
    the settings the cassette was recorded with.
14. **Unresolved issues:** after 2 failed revisions the diagnosis is published with
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
- **Number grounding is unit-blind and loose for small numbers.** A number passes if it matches
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
