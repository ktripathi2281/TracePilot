// Calibration report for scenario A (brief §5: "Calibrate parameters with a script").
// Prints what the model produces; it changes nothing. The same characteristics are asserted in
// src/scenario-a.test.ts.
//
//   pnpm run calibrate [seed ...]

import { US_PER_MIN, US_PER_S, type Patch } from '@tracepilot/schema';
import {
  POOL_EXHAUSTION_CHANGE_IDS,
  POOL_EXHAUSTION_TIMES as T,
  applyPatches,
  metricMax,
  metricMean,
  metricSeries,
  recordPoolExhaustion,
  runSimulation,
  summarizeOutcomes,
  type Recording,
  type SimResult,
} from '../src/index.ts';

const msStr = (us: number): string => `${(us / 1000).toFixed(1)}ms`;
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const mmss = (us: number): string =>
  `${String(Math.floor(us / US_PER_MIN))}:${String(Math.floor((us % US_PER_MIN) / US_PER_S)).padStart(2, '0')}`;

function windowLine(label: string, r: SimResult, from: number, to: number): string {
  const c = summarizeOutcomes(r.outcomes, 'checkout', from, to);
  const s = summarizeOutcomes(r.outcomes, 'stock', from, to);
  const m = r.telemetry.metrics;
  const mean = (svc: string, name: Parameters<typeof metricMean>[2]): number =>
    metricMean(m, svc, name, from, to);
  let exec = 'n/a';
  try {
    exec = msStr(mean('db', 'query_exec_p95'));
  } catch (e) {
    if (!(e instanceof Error)) throw e;
  }
  return [
    label.padEnd(22),
    `co ${c.ratePerS.toFixed(1)}/s err ${pct(c.errorRate)} p50 ${msStr(c.p50Us)} p99 ${msStr(c.p99Us)}`,
    `| stock err ${pct(s.errorRate)} p99 ${msStr(s.p99Us)}`,
    `| pool ${mean('db', 'pool_in_use').toFixed(1)}/${mean('db', 'pool_capacity').toFixed(0)} (max ${metricMax(m, 'db', 'pool_in_use', from, to).toFixed(1)}) waitq ${mean('db', 'pool_wait_queue').toFixed(1)}`,
    `| dbActive ${mean('db', 'db_active_queries').toFixed(1)} dbQ ${mean('db', 'queue_depth').toFixed(2)} execP95 ${exec}`,
    `| co inflight ${mean('checkout', 'in_flight').toFixed(1)}`,
  ].join(' ');
}

function run(rec: Recording, patches: Patch[] = []): SimResult {
  return runSimulation(applyPatches(rec.config, patches), rec.workload);
}

const seeds = process.argv.slice(2).map(Number);
if (seeds.length === 0) seeds.push(42);

for (const seed of seeds) {
  const rec = recordPoolExhaustion(seed);
  const r = run(rec);
  console.log(
    `\n=== seed ${String(seed)}: ${String(rec.workload.requests.length)} requests, ${String(r.stats.eventsProcessed)} events, ${String(r.telemetry.spans.length)} spans, ${String(r.telemetry.logs.length)} logs ===`,
  );
  console.log(windowLine('baseline 1:00-6:00', r, 1 * US_PER_MIN, 6 * US_PER_MIN));
  console.log(windowLine('blip 7:00-7:20', r, T.paymentBlipStartUs, T.paymentBlipEndUs));
  console.log(windowLine('after blip 8:00-10:00', r, 8 * US_PER_MIN, T.deployUs));
  console.log(windowLine('incident 11:00-15:00', r, 11 * US_PER_MIN, T.durationUs));
  const m = r.telemetry.metrics;
  const sat = metricSeries(m, 'db', 'pool_in_use', T.deployUs).find((p) => p.value >= 0.95 * 30);
  const slow = metricSeries(m, 'checkout', 'latency_p99', T.deployUs).find(
    (p) => p.value >= US_PER_S,
  );
  const err = metricSeries(m, 'checkout', 'error_rate', T.deployUs).find((p) => p.value >= 0.05);
  console.log(
    `onsets: pool>=95% at ${sat ? mmss(sat.ts) : 'never'}, checkout p99>=1s at ${slow ? mmss(slow.ts) : 'never'}, checkout err>=5% at ${err ? mmss(err.ts) : 'never'}`,
  );
  console.log(
    `pool: ${String(r.stats.pool.acquireTimeouts)} acquire timeouts; unfinished ${String(r.stats.requestsUnfinished)}; truncated traces ${String(r.stats.tracesTruncated)}`,
  );
  console.log('timeline (30s buckets from 9:30):');
  for (let t = 9.5 * US_PER_MIN; t < T.durationUs; t += 30 * US_PER_S) {
    console.log('  ' + windowLine(mmss(t), r, t, t + 30 * US_PER_S));
  }

  if (seed !== seeds[0]) continue;
  console.log('\n--- counterfactuals (incident window 11:00-15:00) ---');
  const cases: [string, Patch[]][] = [
    ['pool 30 -> 64', [{ target: 'db.pool.capacity', to: 64 }]],
    ['revert deploy', [{ revert: POOL_EXHAUSTION_CHANGE_IDS.checkoutDeploy }]],
    ['revert inventory tweak', [{ revert: POOL_EXHAUSTION_CHANGE_IDS.inventoryTweak }]],
    ['checkout.workers = 20', [{ target: 'checkout.workers', to: 20 }]],
    ['acquire timeout 15s', [{ target: 'db.acquireTimeoutUs', to: 15 * US_PER_S }]],
    ['pool = 200', [{ target: 'db.pool.capacity', to: 200 }]],
  ];
  for (const [label, patches] of cases) {
    const c = run(rec, patches);
    console.log(windowLine(label, c, 11 * US_PER_MIN, T.durationUs));
    console.log(
      `  acquireWait ${(c.stats.pool.totalAcquireWaitUs / US_PER_S).toFixed(0)}s dbQueueWait ${(c.stats.db.totalQueueWaitUs / US_PER_S).toFixed(0)}s timeouts ${String(c.stats.pool.acquireTimeouts)}`,
    );
  }
  console.log('\n--- pool sweep ---');
  for (const cap of [20, 25, 30, 35, 40, 45, 50, 64, 80, 120]) {
    const c = run(rec, [{ target: 'db.pool.capacity', to: cap }]);
    const s = summarizeOutcomes(c.outcomes, 'checkout', 11 * US_PER_MIN, T.durationUs);
    console.log(
      `  pool ${String(cap).padStart(3)}: err ${pct(s.errorRate).padStart(6)} p99 ${msStr(s.p99Us).padStart(10)} acquireWait ${(c.stats.pool.totalAcquireWaitUs / US_PER_S).toFixed(0).padStart(7)}s dbQueueWait ${(c.stats.db.totalQueueWaitUs / US_PER_S).toFixed(0).padStart(6)}s`,
    );
  }
}
