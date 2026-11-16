# TracePilot

AI-native incident investigation + deterministic counterfactual replay for distributed backends.

TracePilot reads the telemetry of an incident (traces, logs, metrics, deploy events), proposes
competing root-cause hypotheses, **tests them against the evidence with deterministic tools**, and
publishes a diagnosis in which every claim cites the telemetry behind it. Then it answers "what if
we had changed X?" by **replaying the recorded workload through a deterministic simulator** of the
system with the change applied.

> **Status (Phase 6).** Everything in the build brief up to the web UI exists and is tested. The
> investigation engine has been exercised with a scripted stand-in for the model, **not yet with a
> real model**: Gate 3 needs one recorded run with an API key (see [NOTES.md](NOTES.md), Phase 3).
> [TRACEPILOT_BUILD_BRIEF.md](TRACEPILOT_BUILD_BRIEF.md) is the plan; [NOTES.md](NOTES.md) is the
> decision log, with every deviation and known gap.

## The three rules

Every design choice follows from these.

1. **Numbers never come from the LLM.** Every latency, rate, count and timestamp shown anywhere
   comes from a deterministic tool or the simulator. The model only cites ledger IDs; a verifier
   rejects any number in its prose that the cited facts do not contain, matched by unit and field.
2. **No claim without evidence.** Every diagnosis statement is backed by typed ledger entries:
   `FACT` (created only by tools, citing stored telemetry), `INFERENCE` (from named premises) or
   `HYPOTHESIS` (never a premise). A deterministic verifier re-reads every fact from the store and
   recomputes it, and rejects fabricated IDs, mismatched numbers, hypotheses used as premises and
   effect-before-cause chains.
3. **No hardcoded demo.** Investigations run for real against the telemetry store. Recorded model
   runs (cassettes) are real past runs, recorded from the API and labelled "recorded"; the scripted
   test fixture is labelled "scripted fixture" everywhere it appears.

## The synthetic-data caveat

**The telemetry in this repository is synthetic**, produced by TracePilot's own simulator. To avoid
grading our own homework:

- The investigator reaches telemetry only through query tools over the store. It never sees the
  simulator config, the scenario name or the ground truth. Lint rules make the agent layer unable
  to import the simulator, the replay package or the eval harness, and incidents get neutral IDs.
- Ground truth lives in `eval/ground-truth/`, read only by the eval harness.
- Scenarios ship with **red herrings** (a harmless config change, a self-resolving latency blip).
- A replay is a **model of system behavior, not a guarantee** of production behavior. Every replay
  result says so.

## Architecture

```
            ┌────────────── simulator side ──────────────┐   ┌──────── investigator side ────────┐
 scenario → │ sim: discrete-event engine, recorded       │   │ store: SQLite telemetry, neutral  │
            │ workload, per-request random streams       │──▶│ incident IDs, evidence IDs        │
            │   │ recording (private: <out>/sim/)        │   │   │                               │
            │   ▼                                        │   │   ▼                               │
            │ replay: same simulator + patches,          │   │ analysis: pure analyzers          │
            │ identity check, headline deltas,           │   │ (windows, anomalies, propagation, │
            │ side effects, sweeps                       │   │ saturation, hold-and-wait, …)     │
            └───────────────┬────────────────────────────┘   │   │                               │
                            │                                │   ▼                               │
 eval: ground truth ────────┤                                │ agents: tools → ledger → tested   │
 (scores both sides)        │                                │ hypotheses → skeptic → verifier   │
                            ▼                                └───────────────┬───────────────────┘
               server (REST + SSE) ◀─────────────────────────────────────────┘
                            │
                    web UI · CLI (tracepilot)
```

| Package                   | Role                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema`         | Zod schemas for telemetry, evidence IDs, ledger, hypotheses, diagnosis, patches.                                                                                                                                                                          |
| `packages/sim`            | Deterministic discrete-event simulator: services with replicas and workers, a DB connection pool and executor, call graphs, scheduled changes. Same inputs ⇒ byte-identical telemetry.                                                                    |
| `packages/store`          | SQLite telemetry store, the only way the agents read data. Stores telemetry only.                                                                                                                                                                         |
| `packages/analysis`       | Pure analyzers over telemetry: incident windows, anomaly onsets, dependency graph, latency attribution, saturation, hold-and-wait, propagation, change correlation. No I/O, no LLM.                                                                       |
| `packages/agents`         | Tools over store + analysis, the evidence ledger, the hypothesis engine (structured predictions the engine runs), the skeptic, the verifier, the Anthropic provider, cassettes and the token budget. Prompts are versioned in `packages/agents/prompts/`. |
| `packages/replay`         | Counterfactual replay and sweeps: the recorded workload through the same simulator with patches; only simulator output becomes a number.                                                                                                                  |
| `packages/cli`            | `tracepilot sim run`, `investigate`, `replay`, `sweep`, `eval`, `serve`.                                                                                                                                                                                  |
| `apps/server`, `apps/web` | REST + SSE API and the UI (React, React Flow, uPlot).                                                                                                                                                                                                     |
| `eval`                    | Ground truth, the eval harness, gate tests and the UI smoke test.                                                                                                                                                                                         |

How an investigation runs: the investigator calls data tools, whose findings become `FACT`s; it
proposes 3–5 hypotheses, each with **predictions the engine checks by running a tool** (a saturated
connection pool requires "pool too small", "hold-and-wait" and "DB slow", each pair discriminated);
a skeptic in a separate context must run new queries against the leading hypothesis and the
strongest alternative; the verifier's deterministic pass then its LLM pass gate publication (two
revision rounds at most). Confidence comes from a rubric over test results, not from the model.

## Non-goals

TracePilot is a scoped MVP. It does **not**:

- integrate with real systems (OpenTelemetry, Prometheus, Grafana, GitHub, a Kubernetes cluster);
  Kubernetes concepts are simulated inside `sim`;
- change any infrastructure: recommendations are suggestions to try in replay; there is no
  autonomous remediation;
- have auth, multi-tenancy or team workflows (bind the server to localhost);
- promise that a replay predicts production: it is a model;
- learn topology or calibrate the simulator from real telemetry.

## Two-minute demo

No API key needed. The investigation shown is the **scripted fixture** (a test double that follows
the protocol on real tool output, labelled as such); with a key, record a real run instead (step 3b).

**0:00 – setup (before the audience arrives)**

```bash
corepack pnpm install
```

```bash
corepack pnpm run tracepilot sim run --scenario pool-exhaustion --seed 42 --out .data
```

```bash
corepack pnpm run web:build
```

```bash
corepack pnpm run tracepilot serve --out .data
```

**0:00 – Overview** (http://127.0.0.1:4318). "Checkout is failing: p99 went from about 130 ms to
16 s, 25 thousand requests failed, throughput fell by two thirds. The graph shows every service red
and the database amber. There were two changes: a config change at T+6:30 and a deploy at T+10:00."

**0:25 – Incident.** Click `checkout` in the graph. "The timeline puts the deploy right before the
anomalies. The slowest trace shows why: checkout opens a transaction, holds its connection for
7.6 s, and inside it the inventory and payment calls wait for connections from the same pool."

**0:50 – Investigation.** Click "run scripted fixture" (or open a recorded run). "Three hypotheses
were tested by the engine, not judged by the model: pool too small, hold-and-wait, DB slow. Two are
rejected by facts: the connections are held idle, not busy; query execution time is flat. Every
claim has a chip; click one and you see the metric points and spans it rests on. The skeptic ran
three new queries; the verifier passed."

**1:25 – Replay lab.** Click "replay →" on the revert recommendation, then Run. "Reverting the
deploy resolves it: zero failures, p99 back to about 130 ms. A pool of 64 also stops the failures,
but the side-effect check shows the DB executor becoming the new bottleneck. The sweep finds the
knee at 60 connections. All of it is simulated from a model, as the banner says."

**3b (with an API key):**

```bash
TRACEPILOT_LLM=record TRACEPILOT_CASSETTE_DIR=eval/cassettes corepack pnpm run tracepilot investigate --incident in_rm6f1z3tf --out .data --stream
```

## Eval results

`tracepilot eval` simulates each scenario, investigates it, scores the diagnosis against
`eval/ground-truth/` and replays the recommended patch. **Read the Investigator column first.**
"scripted fixture" is a test double that follows the investigation protocol on real tool output;
its rows test the engine (tools, verifier, replay), **not a model's reasoning**, and its fixed
procedure is written for connection-pool incidents. A model row appears once a real run is
recorded (`eval/cassettes/`, see NOTES.md, Phase 3).

<!-- eval:start (generated by `tracepilot eval --write-readme`) -->

| Scenario                  | Investigator     | Root cause                                                              | Evidence valid | Hallucinations | Red herrings not blamed | Skeptic challenged | Recommended patch in replay     | Overall  |
| ------------------------- | ---------------- | ----------------------------------------------------------------------- | -------------- | -------------- | ----------------------- | ------------------ | ------------------------------- | -------- |
| pool-exhaustion (seed 42) | scripted fixture | match (hold_and_wait)                                                   | 100% of 97     | 0              | yes                     | yes                | `revert ev_2` (cause): resolves | **pass** |
| pool-exhaustion (seed 42) | model (recorded) | not run: no recorded cassette yet (needs an API key; NOTES.md, Phase 3) | —              | —              | —                       | —                  | —                               | —        |
| pool-exhaustion (seed 3)  | scripted fixture | match (hold_and_wait)                                                   | 100% of 96     | 0              | yes                     | yes                | `revert ev_2` (cause): resolves | **pass** |
| pool-exhaustion (seed 3)  | model (recorded) | not run: no recorded cassette yet (needs an API key; NOTES.md, Phase 3) | —              | —              | —                       | —                  | —                               | —        |
| pool-exhaustion (seed 7)  | scripted fixture | match (hold_and_wait)                                                   | 100% of 97     | 0              | yes                     | yes                | `revert ev_2` (cause): resolves | **pass** |
| pool-exhaustion (seed 7)  | model (recorded) | not run: no recorded cassette yet (needs an API key; NOTES.md, Phase 3) | —              | —              | —                       | —                  | —                               | —        |

<!-- eval:end -->

Columns: root cause = the diagnosis names the ground truth's mechanism and cites the culprit
change; evidence valid = ledger facts that re-verify against the store (must be 100 %);
hallucinations = problems an independent re-verification finds in the published diagnosis
(fabricated IDs, mismatched or ungrounded numbers, hypotheses as premises; must be 0); recommended
patch = the first cause recommendation, replayed.

## Running it

Requires Node ≥ 22.12. pnpm is pinned via `packageManager` and runs through corepack. The SQLite
driver (`better-sqlite3`) may compile during install, which needs a C++ toolchain where no prebuilt
binary exists.

```bash
corepack pnpm install
```

```bash
corepack pnpm run ci
```

`ci` runs format check, lint, typecheck and tests (including the UI smoke test, which drives the
installed Edge or Chrome).

| Command                                                                       | What it does                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracepilot sim run --scenario <name> [--seed n] --out .data`                 | Simulate a scenario; telemetry goes to `.data/telemetry.db` under a neutral incident ID, the private replay recording to `.data/sim/`.                                       |
| `tracepilot investigate --incident <id> [--stream]`                           | Investigate; prints the diagnosis with its citations and saves the record to `.data/investigations/`. Needs `ANTHROPIC_API_KEY`, or `TRACEPILOT_LLM=replay` with a cassette. |
| `tracepilot replay --incident <id> --patch db.pool.capacity=64`               | Replay with a patch (`--revert <changeEventId>`, `--variant <name>:<service>`, or `--diagnosis <file>` for every recommendation).                                            |
| `tracepilot sweep --incident <id> --param db.pool.capacity --range 20:120:10` | Replay a range of one knob: knee, first resolving value, bottleneck shift.                                                                                                   |
| `tracepilot serve --out .data`                                                | The API and the web UI on http://127.0.0.1:4318 (build the UI first with `pnpm run web:build`).                                                                              |

Run the CLI as `corepack pnpm run tracepilot <command>`. LLM settings (model, effort, token budget,
cassette mode) are in [.env.example](.env.example). Exit codes: 0 done, 1 failed, 2 diagnosis not
verified, 64 bad input.
