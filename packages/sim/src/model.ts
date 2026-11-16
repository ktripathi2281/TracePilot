// Declarative system model, workload and recording (brief §3). Everything here is plain JSON so a
// recorded incident can be saved, reloaded and replayed against a patched model.

import { ChangeEvent, DurationUs, ServiceName, VirtualTimeUs } from '@tracepilot/schema';
import { z } from 'zod';

const PositiveInt = z.number().int().positive();

/** Step labels become part of draw keys and span paths, so the path separators are excluded. */
export const StepLabel = z
  .string()
  .regex(/^[a-z][a-z0-9.-]*$/, 'label must match [a-z][a-z0-9.-]*');

// ---- Service-time distributions -------------------------------------------------------------

export const Dist = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('constant'), valueUs: PositiveInt }),
  z.strictObject({ kind: z.literal('exponential'), meanUs: PositiveInt }),
  z.strictObject({
    kind: z.literal('lognormal'),
    medianUs: PositiveInt,
    sigma: z.number().min(0).max(3),
  }),
]);
export type Dist = z.infer<typeof Dist>;

// ---- Steps (the call graph of an operation) -------------------------------------------------

export const RetryPolicy = z.strictObject({
  /** Total attempts including the first. */
  maxAttempts: z.number().int().min(1).max(10),
  /** Backoff before attempt k+1 is backoffUs * 2^(k-1). */
  backoffUs: DurationUs,
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

/** Own CPU work. Holds the worker, emits no span (it is the residual of the server span). */
export interface ComputeStep {
  kind: 'compute';
  label: string;
  dist: Dist;
}
/**
 * One DB query. Outside a transaction it acquires a pooled connection, executes and releases.
 * Directly inside a transaction it runs on the transaction's connection.
 */
export interface QueryStep {
  kind: 'query';
  label: string;
  dist: Dist;
}
/** Call to a dependency that is not modeled as a service (e.g. a payment provider). */
export interface ExternalStep {
  kind: 'external';
  label: string;
  peer: string;
  dist: Dist;
  /** Emit a warn log when the call takes longer than this. */
  slowLogThresholdUs?: number | undefined;
}
/** Synchronous call to another modeled service. */
export interface CallStep {
  kind: 'call';
  label: string;
  service: string;
  operation: string;
  retry?: RetryPolicy | undefined;
}
/** Runs branches concurrently; fails fast and cancels siblings when one fails. */
export interface ParallelStep {
  kind: 'parallel';
  label: string;
  branches: Step[][];
}
/** N concurrent copies of `steps`, N read from the service's `params[countParam]` at start. */
export interface FanoutStep {
  kind: 'fanout';
  label: string;
  countParam: string;
  steps: Step[];
}
/**
 * Holds ONE pooled connection from start to end of `steps` (commit/rollback). Queries directly
 * inside use that connection. Calls and parallel branches inside do NOT inherit it: a downstream
 * service that needs the DB must acquire its own connection while this one stays held.
 */
export interface TransactionStep {
  kind: 'transaction';
  label: string;
  steps: Step[];
  /**
   * Counterfactual model variant (never in a recorded model): `around-calls` releases the
   * connection before every step that is not DB work (calls, parallel, fan-out, external) and
   * acquires a fresh one for the DB work after it. The transaction is no longer atomic; that is
   * the price of the variant and the replay says so.
   */
  release?: 'around-calls' | undefined;
}
/**
 * Cache-aside read (Scenario C). The lookup takes `lookup` time; it is a hit with probability
 * entries / keySpace, where keySpace is the service parameter `keySpaceParam` (how many distinct
 * keys requests use) and entries grows by one per miss up to the cache capacity. On a miss `steps`
 * (the backing read) run and then fill the cache. When the key space parameter changes (a new key
 * format), the existing entries no longer match anything and the cache starts empty.
 */
export interface CacheStep {
  kind: 'cache';
  label: string;
  keySpaceParam: string;
  lookup: Dist;
  steps: Step[];
}
export type Step =
  | ComputeStep
  | QueryStep
  | ExternalStep
  | CallStep
  | ParallelStep
  | FanoutStep
  | TransactionStep
  | CacheStep;

export const Step: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('compute'), label: StepLabel, dist: Dist }),
    z.strictObject({ kind: z.literal('query'), label: StepLabel, dist: Dist }),
    z.strictObject({
      kind: z.literal('external'),
      label: StepLabel,
      peer: z.string().min(1),
      dist: Dist,
      slowLogThresholdUs: PositiveInt.optional(),
    }),
    z.strictObject({
      kind: z.literal('call'),
      label: StepLabel,
      service: ServiceName,
      operation: z.string().min(1),
      retry: RetryPolicy.optional(),
    }),
    z.strictObject({
      kind: z.literal('parallel'),
      label: StepLabel,
      branches: z.array(z.array(Step).min(1)).min(1),
    }),
    z.strictObject({
      kind: z.literal('fanout'),
      label: StepLabel,
      countParam: z.string().min(1),
      steps: z.array(Step).min(1),
    }),
    z.strictObject({
      kind: z.literal('transaction'),
      label: StepLabel,
      steps: z.array(Step).min(1),
      release: z.literal('around-calls').optional(),
    }),
    z.strictObject({
      kind: z.literal('cache'),
      label: StepLabel,
      keySpaceParam: z.string().min(1),
      lookup: Dist,
      steps: z.array(Step).min(1),
    }),
  ]),
);

// ---- System model ---------------------------------------------------------------------------

export const Operation = z.strictObject({ steps: z.array(Step).min(1) });
export type Operation = z.infer<typeof Operation>;

/**
 * Pod lifecycle (Kubernetes-style, simulated; brief §5 Scenario D). Each replica is a pod whose
 * memory is base + perRequest × requests it is processing. Above the limit the pod is OOMKilled:
 * its in-flight and queued requests fail, it restarts after an exponential back-off
 * (CrashLoopBackOff from the second consecutive kill) and takes traffic again once started.
 * Only ready pods receive requests.
 */
export const PodModel = z.strictObject({
  memoryBaseBytes: PositiveInt,
  memoryPerRequestBytes: z.number().int().nonnegative(),
  memoryLimitBytes: PositiveInt,
  /** First restart delay; doubles with every consecutive kill, up to maxBackoffUs. */
  restartBackoffUs: PositiveInt,
  maxBackoffUs: PositiveInt,
  /** From restart to ready (taking traffic). */
  startupUs: PositiveInt,
  /** A pod that stayed up this long starts its back-off from the beginning again. */
  backoffResetUs: PositiveInt,
});
export type PodModel = z.infer<typeof PodModel>;

export const ServiceModel = z.strictObject({
  /** Identical pods, load-balanced round-robin, each with its own workers and queue. */
  replicas: PositiveInt,
  /** Max concurrent requests per replica. */
  workers: PositiveInt,
  /** Max requests waiting for a worker per replica; beyond it requests are rejected (503). */
  queueLimit: z.number().int().nonnegative(),
  /** Deadline from arrival at the service (queue wait included). */
  timeoutUs: PositiveInt,
  /** Named numeric parameters read by steps (e.g. a fan-out count). */
  params: z.record(z.string().min(1), z.number().int().nonnegative()),
  operations: z.record(z.string().min(1), Operation),
  /** Optional pod lifecycle; without it replicas never fail. */
  pods: PodModel.optional(),
});
export type ServiceModel = z.infer<typeof ServiceModel>;

export const DbModel = z.strictObject({
  pool: z.strictObject({ capacity: PositiveInt }),
  /** Max time a caller waits in the pool's FIFO queue for a connection. */
  acquireTimeoutUs: PositiveInt,
  /** Queries executing at once; beyond it queries queue at the DB while holding a connection. */
  maxParallelQueries: PositiveInt,
});
export type DbModel = z.infer<typeof DbModel>;

/** Reserved name of the shared database component in telemetry and patch targets. */
export const DB_SERVICE = 'db';

export const SystemModel = z.strictObject({
  services: z.record(ServiceName, ServiceModel),
  db: DbModel,
  /** Optional shared cache tier (Scenario C): how many entries each cache step can hold. */
  cache: z.strictObject({ capacity: PositiveInt }).optional(),
  /** Request type → entry point. */
  requestTypes: z.record(
    z.string().regex(/^[a-z][a-z0-9-]*$/),
    z.strictObject({ service: ServiceName, operation: z.string().min(1) }),
  ),
});
export type SystemModel = z.infer<typeof SystemModel>;

// ---- Environment effects that are not config changes ----------------------------------------

/** Multiplies the duration of one labeled step of one service during a time window. */
export const Disturbance = z
  .strictObject({
    description: z.string().min(1),
    startUs: VirtualTimeUs,
    endUs: VirtualTimeUs,
    service: ServiceName,
    step: StepLabel,
    factor: z.number().positive(),
  })
  .refine((d) => d.endUs > d.startUs, { message: 'endUs must be > startUs', path: ['endUs'] });
export type Disturbance = z.infer<typeof Disturbance>;

// ---- Run configuration ----------------------------------------------------------------------

export const SimOptions = z.strictObject({
  /** Head-sampling rate for traces and request-scoped logs. Metrics always count every request. */
  traceSampleRate: z.number().min(0).max(1),
  metricIntervalUs: PositiveInt,
  /** Mean gap between background noise logs per service; 0 disables them. */
  noiseLogMeanIntervalUs: DurationUs,
});
export type SimOptions = z.infer<typeof SimOptions>;

export const SimConfig = z.strictObject({
  scenario: z.string().min(1),
  durationUs: PositiveInt,
  model: SystemModel,
  /**
   * Scheduled change events. A diff key `k` on an event for service `s` changes knob `s.k` at
   * `ts` when that knob exists (see knobs.ts); other keys (e.g. `version`) are informational.
   */
  changes: z.array(ChangeEvent),
  disturbances: z.array(Disturbance),
  /** Knob targets pinned by counterfactual patches: scheduled changes no longer alter them. */
  pins: z.array(z.string().min(1)),
  options: SimOptions,
});
export type SimConfig = z.infer<typeof SimConfig>;

// ---- Workload -------------------------------------------------------------------------------

export const WorkloadRequest = z.strictObject({
  requestId: z.number().int().nonnegative(),
  arrivalUs: VirtualTimeUs,
  type: z.string().min(1),
});
export type WorkloadRequest = z.infer<typeof WorkloadRequest>;

/** A recorded list of arrivals plus the seed all request-scoped randomness derives from. */
export const Workload = z.strictObject({
  seed: z.number().int().nonnegative(),
  requests: z.array(WorkloadRequest),
});
export type Workload = z.infer<typeof Workload>;

/** Everything needed to reproduce (or counterfactually replay) a run. */
export const Recording = z.strictObject({
  formatVersion: z.literal(1),
  config: SimConfig,
  workload: Workload,
});
export type Recording = z.infer<typeof Recording>;

// ---- Semantic validation --------------------------------------------------------------------

function* walkSteps(steps: readonly Step[]): Generator<Step> {
  for (const s of steps) {
    yield s;
    if (s.kind === 'parallel') for (const b of s.branches) yield* walkSteps(b);
    else if (s.kind === 'fanout' || s.kind === 'transaction' || s.kind === 'cache')
      yield* walkSteps(s.steps);
  }
}

function checkSiblingLabels(steps: readonly Step[], where: string, problems: string[]): void {
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.label)) problems.push(`${where}: duplicate step label "${s.label}"`);
    seen.add(s.label);
    const inner = `${where}/${s.label}`;
    if (s.kind === 'parallel') s.branches.forEach((b) => checkSiblingLabels(b, inner, problems));
    else if (s.kind === 'fanout' || s.kind === 'transaction' || s.kind === 'cache')
      checkSiblingLabels(s.steps, inner, problems);
  }
}

/** Returns a list of problems that the structural schema cannot express. Empty = valid. */
export function findConfigProblems(config: SimConfig): string[] {
  const problems: string[] = [];
  const { model } = config;
  if (DB_SERVICE in model.services) problems.push(`"${DB_SERVICE}" is reserved for the database`);

  const calls = new Map<string, string[]>(); // "svc.op" -> callee "svc.op"[]
  for (const [svcName, svc] of Object.entries(model.services)) {
    for (const [opName, op] of Object.entries(svc.operations)) {
      const here = `${svcName}.${opName}`;
      checkSiblingLabels(op.steps, here, problems);
      const out: string[] = [];
      for (const s of walkSteps(op.steps)) {
        if (s.kind === 'call') {
          if (model.services[s.service]?.operations[s.operation] === undefined)
            problems.push(`${here}: call to unknown ${s.service}.${s.operation}`);
          out.push(`${s.service}.${s.operation}`);
        } else if (s.kind === 'fanout' && svc.params[s.countParam] === undefined) {
          problems.push(`${here}: fanout reads unknown param "${s.countParam}"`);
        } else if (s.kind === 'cache') {
          if (model.cache === undefined) problems.push(`${here}: cache step but no cache tier`);
          if ((svc.params[s.keySpaceParam] ?? 0) < 1)
            problems.push(`${here}: cache reads unknown or zero param "${s.keySpaceParam}"`);
        }
      }
      calls.set(here, out);
    }
  }
  // Call graphs must be acyclic.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (node: string): void => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
      problems.push(`call cycle through ${node}`);
      return;
    }
    state.set(node, 'visiting');
    for (const next of calls.get(node) ?? []) visit(next);
    state.set(node, 'done');
  };
  for (const node of calls.keys()) visit(node);

  for (const [type, entry] of Object.entries(model.requestTypes)) {
    if (model.services[entry.service]?.operations[entry.operation] === undefined)
      problems.push(`request type "${type}": unknown entry ${entry.service}.${entry.operation}`);
  }
  const ids = new Set<string>();
  for (const ev of config.changes) {
    if (ids.has(ev.id)) problems.push(`duplicate change event id ${ev.id}`);
    ids.add(ev.id);
    if (ev.service !== DB_SERVICE && model.services[ev.service] === undefined)
      problems.push(`change ${ev.id}: unknown service "${ev.service}"`);
    if ('replicas' in ev.diff)
      problems.push(`change ${ev.id}: replicas is a static knob and cannot change mid-run yet`);
  }
  for (const d of config.disturbances) {
    const svc = model.services[d.service];
    const found =
      svc !== undefined &&
      Object.values(svc.operations).some((op) =>
        [...walkSteps(op.steps)].some((s) => s.label === d.step),
      );
    if (!found) problems.push(`disturbance "${d.description}": no step ${d.service}/${d.step}`);
  }
  return problems;
}

export function assertValidConfig(config: SimConfig): void {
  const problems = findConfigProblems(config);
  if (problems.length > 0) throw new Error(`invalid sim config:\n- ${problems.join('\n- ')}`);
}
