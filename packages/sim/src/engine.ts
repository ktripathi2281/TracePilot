// Deterministic discrete-event simulation of the system model (brief §3).
//
// Rules this file must keep:
// - Virtual time only (integer microseconds). No wall clock, no ambient randomness.
// - Every request-scoped random draw goes through drawUs(), keyed by (seed, requestId, path).
// - The event order is fully determined by (time, scheduling sequence).
//
// Execution model in one paragraph: a request enters its entry service; each service call picks a
// replica round-robin, takes a worker or waits in that replica's FIFO queue (rejected with 503
// when the queue is full), then runs the operation's steps. Steps are compute, query, external,
// call, parallel, fanout and transaction (see model.ts). DB access goes through one shared
// connection pool (FIFO wait queue, acquire timeout) and then a DB executor with a parallelism
// limit (FIFO queue at the DB while the connection stays held). A service deadline or a failed
// parallel sibling CANCELS work: anything waiting in a queue leaves it at once; a step that is
// already executing (compute, running query, external call) runs to completion and its handler
// then unwinds and frees its worker/connection.

import {
  SPAN_ATTRS,
  SPAN_NAMES,
  US_PER_MS,
  US_PER_S,
  type AttributeValue,
  type ChangeEvent,
  type LogLevel,
  type LogRecord,
  type MetricName,
  type MetricPoint,
  type PodEvent,
  type Span,
  type SpanStatus,
} from '@tracepilot/schema';
import { getKnob, setKnob } from './knobs.ts';
import {
  DB_SERVICE,
  assertValidConfig,
  type CacheStep,
  type CallStep,
  type Dist,
  type Disturbance,
  type ExternalStep,
  type QueryStep,
  type ServiceModel,
  type SimConfig,
  type Step,
  type SystemModel,
  type Workload,
} from './model.ts';
import {
  childPath,
  hashString,
  indexedPath,
  mulberry32,
  sampleDist,
  spanIdFor,
  traceIdFor,
  uniform,
} from './rng.ts';
import { EventQueue, Fifo, Gauge, Scope, percentileSorted, round3, type Timer } from './util.ts';

// ---- Public result types --------------------------------------------------------------------

export interface Telemetry {
  spans: Span[];
  logs: LogRecord[];
  metrics: MetricPoint[];
  changeEvents: ChangeEvent[];
  podEvents: PodEvent[];
}

export type OutcomeStatus = 'ok' | 'error' | 'timeout';

/** One finished request as seen at the entry service. Not telemetry: used by tests and replay. */
export interface RequestOutcome {
  requestId: number;
  type: string;
  arrivalUs: number;
  endUs: number;
  status: OutcomeStatus;
  httpStatus: number;
}

export interface SimStats {
  eventsProcessed: number;
  requestsArrived: number;
  requestsFinished: number;
  /** Requests still in flight when the run ended. */
  requestsUnfinished: number;
  /** Sampled traces dropped because the run ended before they were complete. */
  tracesTruncated: number;
  pool: {
    acquireCount: number;
    acquireTimeouts: number;
    /** Sum of time spent waiting for a connection over every acquire attempt, incl. failed ones. */
    totalAcquireWaitUs: number;
    /** Sum of connection hold time (granted → released). */
    totalHoldUs: number;
  };
  db: {
    queryCount: number;
    /** Sum of time queries spent queued at the DB executor. */
    totalQueueWaitUs: number;
    /** Sum of pure execution time. */
    totalExecUs: number;
  };
  services: Record<
    string,
    { responses: number; errors: number; rejected: number; totalLatencyUs: number }
  >;
  /**
   * Exact time-averages over the whole run. Metrics carry point samples of the same gauges;
   * these exist so conservation (Little's law) can be checked against independent totals.
   */
  timeAverages: {
    poolInUse: number;
    poolWaiting: number;
    dbActive: number;
    dbQueued: number;
    services: Record<string, { inFlight: number; queueDepth: number }>;
  };
  /** Resource occupancy when the run ended. All zero once the system has drained. */
  finalState: {
    poolInUse: number;
    poolWaiting: number;
    dbActive: number;
    dbQueued: number;
    busyWorkers: number;
    queuedRequests: number;
  };
}

export interface SimResult {
  telemetry: Telemetry;
  outcomes: RequestOutcome[];
  stats: SimStats;
  /** Base (undisturbed) draws by `${requestId}|${path}`, only when `recordDraws` is set. */
  draws?: Map<string, number>;
}

export interface RunOptions {
  recordDraws?: boolean;
}

// ---- Internals ------------------------------------------------------------------------------

type Status = 'ok' | 'error' | 'timeout' | 'cancelled';
type Done = (status: Status) => void;

interface Req {
  id: number;
  type: string;
  sampled: boolean;
  /** Derived on first use (see traceOf). */
  traceId: string | null;
}

/** Execution context of a sequence of steps. */
interface Env {
  req: Req;
  svc: ServiceRt;
  scope: Scope;
  /** True when these steps run directly inside a transaction and may use its connection. */
  holdsConn: boolean;
  parentSpanId: string | null;
}

interface Waiter {
  active: boolean;
  run: () => void;
  /** Replica queues only: the pod died while this request waited. */
  fail?: () => void;
}
interface PoolWaiter extends Waiter {
  startTs: number;
}

interface Replica {
  busy: number;
  queue: Fifo<Waiter>;
  /** Pod lifecycle (only for services with a pod model; otherwise always ready). */
  ready: boolean;
  /** Kill handles of the requests this pod is processing. */
  inflight: Set<() => void>;
  backoffLevel: number;
  readySince: number;
}

interface ServiceRt {
  name: string;
  /** This service in the live model. */
  cfg: ServiceModel;
  replicas: Replica[];
  rr: number;
  inFlight: Gauge;
  queueDepth: Gauge;
  windowLatencies: number[];
  windowErrors: number;
  windowRejected: number;
  /** Pod restarts so far (pod model only). */
  restarts: number;
  /** True when one of its operations has a cache step; only then is cache_hit_ratio emitted. */
  hasCache: boolean;
  windowCacheLookups: number;
  windowCacheHits: number;
  responses: number;
  errors: number;
  rejected: number;
  totalLatencyUs: number;
}

const HTTP: Readonly<Record<Status, number>> = {
  ok: 200,
  error: 500,
  timeout: 504,
  cancelled: 499,
};
const SLOW_QUERY_LOG_US = 250 * US_PER_MS;

/** Irrelevant-but-true background logs, per service kind. `{n}` is replaced by a drawn number. */
const NOISE: readonly { level: LogLevel; message: string; field: string; max: number }[] = [
  { level: 'info', message: 'health check ok', field: 'latencyMs', max: 4 },
  { level: 'debug', message: 'gc pause', field: 'pauseMs', max: 18 },
  { level: 'info', message: 'metrics flushed', field: 'points', max: 400 },
  { level: 'debug', message: 'config watcher: no changes', field: 'revision', max: 3 },
  { level: 'info', message: 'cache refresh completed', field: 'entries', max: 5000 },
  { level: 'warn', message: 'slow DNS lookup', field: 'lookupMs', max: 180 },
  { level: 'info', message: 'tls certificate check ok', field: 'daysLeft', max: 80 },
];
const DB_NOISE: readonly { level: LogLevel; message: string; field: string; max: number }[] = [
  { level: 'info', message: 'checkpoint complete', field: 'buffersWritten', max: 900 },
  { level: 'info', message: 'autovacuum finished', field: 'deadTuples', max: 3000 },
  { level: 'debug', message: 'wal segment archived', field: 'segment', max: 4000 },
];

/**
 * One simulation run. A class (not a function full of closures) on purpose: the engine's
 * functions are shared prototype methods, so call sites stay monomorphic no matter how many runs
 * happen in one process (replays and sweeps run many).
 */
class Simulation {
  private readonly config: SimConfig;
  private readonly workload: Workload;
  /** Live copy of the model, mutated by scheduled change events. */
  private readonly model: SystemModel;
  private readonly pins: ReadonlySet<string>;
  private readonly seed: number;
  private readonly durationUs: number;
  private readonly traceSampleRate: number;
  private readonly metricIntervalUs: number;

  private readonly heap = new EventQueue();
  private now = 0;

  private readonly spans: Span[] = [];
  private readonly logs: LogRecord[] = [];
  private readonly metrics: MetricPoint[] = [];
  private readonly changeEvents: ChangeEvent[] = [];
  private readonly podEvents: PodEvent[] = [];
  /** Cache contents per cache step (`service/label`): entries held, and the key space they are for. */
  private readonly caches = new Map<string, { entries: number; keySpace: number }>();
  private podSeq = 0;
  private readonly outcomes: RequestOutcome[] = [];
  private readonly draws: Map<string, number> | undefined;
  /** service → step label → disturbances. */
  private readonly disturbances = new Map<string, Map<string, Disturbance[]>>();

  private readonly services = new Map<string, ServiceRt>();
  private readonly poolQueue = new Fifo<PoolWaiter>();
  private poolInUseCount = 0;
  private readonly poolInUse = new Gauge();
  private readonly poolWaiting = new Gauge();
  private readonly dbQueue = new Fifo<Waiter>();
  private dbActiveCount = 0;
  private readonly dbActive = new Gauge();
  private readonly dbQueued = new Gauge();
  private windowExec: number[] = [];
  private windowQueries = 0;

  private readonly poolStats = {
    acquireCount: 0,
    acquireTimeouts: 0,
    totalAcquireWaitUs: 0,
    totalHoldUs: 0,
  };
  private readonly dbStats = { queryCount: 0, totalQueueWaitUs: 0, totalExecUs: 0 };
  private requestsFinished = 0;
  private nextArrival = 0;
  private logSeq = 0;

  constructor(config: SimConfig, workload: Workload, opts: RunOptions) {
    assertValidConfig(config);
    this.config = config;
    this.workload = workload;
    this.model = structuredClone(config.model);
    this.pins = new Set(config.pins);
    this.seed = workload.seed;
    this.durationUs = config.durationUs;
    this.traceSampleRate = config.options.traceSampleRate;
    this.metricIntervalUs = config.options.metricIntervalUs;
    this.draws = opts.recordDraws === true ? new Map<string, number>() : undefined;

    for (const d of config.disturbances) {
      let byStep = this.disturbances.get(d.service);
      if (byStep === undefined) {
        byStep = new Map();
        this.disturbances.set(d.service, byStep);
      }
      const list = byStep.get(d.step);
      if (list === undefined) byStep.set(d.step, [d]);
      else list.push(d);
    }
    for (const [name, svc] of Object.entries(this.model.services)) {
      this.services.set(name, {
        name,
        cfg: svc,
        replicas: Array.from({ length: svc.replicas }, () => ({
          busy: 0,
          queue: new Fifo<Waiter>(),
          ready: true,
          inflight: new Set<() => void>(),
          backoffLevel: 0,
          readySince: 0,
        })),
        rr: 0,
        inFlight: new Gauge(),
        queueDepth: new Gauge(),
        windowLatencies: [],
        windowErrors: 0,
        windowRejected: 0,
        restarts: 0,
        hasCache: Object.values(svc.operations).some((op) => hasCacheStep(op.steps)),
        windowCacheLookups: 0,
        windowCacheHits: 0,
        responses: 0,
        errors: 0,
        rejected: 0,
        totalLatencyUs: 0,
      });
    }
  }

  // ---- Telemetry helpers --------------------------------------------------------------------

  private log(
    service: string,
    level: LogLevel,
    message: string,
    fields: Record<string, AttributeValue>,
    req?: Req,
  ): void {
    const record: LogRecord = {
      id: `lg_${(this.logSeq++).toString(36)}`,
      ts: this.now,
      service,
      level,
      message,
      fields,
    };
    if (req !== undefined) record.traceId = traceOf(this.seed, req);
    this.logs.push(record);
  }

  private emitSpan(
    req: Req,
    path: string,
    parentSpanId: string | null,
    service: string,
    name: string,
    startUs: number,
    status: SpanStatus,
    attributes: Record<string, AttributeValue>,
  ): void {
    this.spans.push({
      traceId: traceOf(this.seed, req),
      spanId: spanIdFor(this.seed, req.id, path),
      parentSpanId,
      service,
      name,
      startUs,
      endUs: this.now,
      status,
      attributes,
    });
  }

  /** The only source of request-scoped randomness. */
  private drawUs(env: Env, label: string, dist: Dist, path: string): number {
    const base = sampleDist(dist, this.seed, env.req.id, path);
    if (this.draws !== undefined) this.draws.set(`${String(env.req.id)}|${path}`, base);
    const active = this.disturbances.get(env.svc.name)?.get(label);
    if (active === undefined) return base;
    let factor = 1;
    for (const d of active) if (this.now >= d.startUs && this.now < d.endUs) factor *= d.factor;
    return factor === 1 ? base : Math.max(1, Math.round(base * factor));
  }

  // ---- Connection pool ----------------------------------------------------------------------

  private pumpPool(): void {
    while (this.poolInUseCount < this.model.db.pool.capacity) {
      const waiter = this.poolQueue.shift();
      if (waiter === undefined) break;
      this.poolWaiting.add(this.now, -1);
      this.poolInUseCount++;
      this.poolInUse.add(this.now, 1);
      waiter.run();
    }
  }

  /** Calls done('ok') once a connection is held; the caller must releaseConn() exactly once. */
  private acquire(env: Env, path: string, what: string, done: Done): void {
    if (env.scope.cancelled) {
      done('cancelled');
      return;
    }
    const startTs = this.now;
    const capacity = this.model.db.pool.capacity;
    const inUseAtRequest = this.poolInUseCount;
    const waitersAtRequest = this.poolQueue.size;
    this.poolStats.acquireCount++;
    const finish = (status: SpanStatus, cancelled: boolean): void => {
      this.poolStats.totalAcquireWaitUs += this.now - startTs;
      if (!env.req.sampled) return;
      const attrs: Record<string, AttributeValue> = {
        [SPAN_ATTRS.dbStatement]: what,
        [SPAN_ATTRS.poolCapacity]: capacity,
        [SPAN_ATTRS.poolInUseAtAcquire]: inUseAtRequest,
        [SPAN_ATTRS.poolWaitQueueAtAcquire]: waitersAtRequest,
      };
      if (cancelled) attrs[SPAN_ATTRS.cancelled] = true;
      this.emitSpan(
        env.req,
        path,
        env.parentSpanId,
        env.svc.name,
        SPAN_NAMES.poolAcquire,
        startTs,
        status,
        attrs,
      );
    };
    if (inUseAtRequest < capacity && waitersAtRequest === 0) {
      this.poolInUseCount++;
      this.poolInUse.add(this.now, 1);
      finish('ok', false);
      done('ok');
      return;
    }
    const timeoutUs = this.model.db.acquireTimeoutUs;
    const waiter: PoolWaiter = {
      active: true,
      startTs,
      run: () => {
        off();
        timer.cancel();
        finish('ok', false);
        done('ok');
      },
    };
    this.poolQueue.push(waiter);
    this.poolWaiting.add(this.now, 1);
    const off = env.scope.onCancel(() => {
      this.poolQueue.remove(waiter);
      this.poolWaiting.add(this.now, -1);
      timer.cancel();
      finish('error', true);
      done('cancelled');
    });
    const timer: Timer = this.heap.push(startTs + timeoutUs, () => {
      this.poolQueue.remove(waiter);
      this.poolWaiting.add(this.now, -1);
      off();
      this.poolStats.acquireTimeouts++;
      finish('timeout', false);
      if (env.req.sampled) {
        this.log(
          env.svc.name,
          'error',
          `timeout acquiring connection after ${String(Math.round(timeoutUs / US_PER_MS))}ms`,
          {
            statement: what,
            poolCapacity: this.model.db.pool.capacity,
            poolInUse: this.poolInUseCount,
            poolWaiters: this.poolQueue.size,
          },
          env.req,
        );
      }
      done('error');
    });
  }

  private releaseConn(heldSince: number): void {
    this.poolStats.totalHoldUs += this.now - heldSince;
    this.poolInUseCount--;
    this.poolInUse.add(this.now, -1);
    this.pumpPool();
  }

  // ---- DB executor --------------------------------------------------------------------------

  private pumpDb(): void {
    while (this.dbActiveCount < this.model.db.maxParallelQueries) {
      const next = this.dbQueue.shift();
      if (next === undefined) break;
      this.dbQueued.add(this.now, -1);
      next.run();
    }
  }

  private querySpan(
    env: Env,
    path: string,
    step: QueryStep,
    requestedAt: number,
    activeAtRequest: number,
    queueWaitUs: number,
    cancelled: boolean,
  ): void {
    const attrs: Record<string, AttributeValue> = {
      [SPAN_ATTRS.dbStatement]: step.label,
      [SPAN_ATTRS.dbActiveQueriesAtStart]: activeAtRequest,
      [SPAN_ATTRS.dbQueueWaitUs]: queueWaitUs,
    };
    if (cancelled) attrs[SPAN_ATTRS.cancelled] = true;
    this.emitSpan(
      env.req,
      path,
      env.parentSpanId,
      env.svc.name,
      SPAN_NAMES.dbQuery,
      requestedAt,
      cancelled ? 'error' : 'ok',
      attrs,
    );
  }

  /** Executes one query on a connection the caller already holds. */
  private dbExec(env: Env, path: string, step: QueryStep, done: Done): void {
    if (env.scope.cancelled) {
      done('cancelled');
      return;
    }
    const requestedAt = this.now;
    const activeAtRequest = this.dbActiveCount;
    const run = (): void => {
      const queueWaitUs = this.now - requestedAt;
      this.dbActiveCount++;
      this.dbActive.add(this.now, 1);
      const execUs = this.drawUs(env, step.label, step.dist, path);
      this.heap.push(this.now + execUs, () => {
        this.dbActiveCount--;
        this.dbActive.add(this.now, -1);
        this.dbStats.queryCount++;
        this.dbStats.totalQueueWaitUs += queueWaitUs;
        this.dbStats.totalExecUs += execUs;
        const totalUs = this.now - requestedAt;
        this.windowExec.push(totalUs);
        this.windowQueries++;
        if (env.req.sampled) {
          // The DB finishes a running query even if the caller has gone away.
          this.querySpan(env, path, step, requestedAt, activeAtRequest, queueWaitUs, false);
          if (totalUs > SLOW_QUERY_LOG_US) {
            this.log(
              env.svc.name,
              'warn',
              'slow query',
              { statement: step.label, durationMs: round3(totalUs / US_PER_MS) },
              env.req,
            );
          }
        }
        this.pumpDb();
        done(env.scope.cancelled ? 'cancelled' : 'ok');
      });
    };
    if (this.dbActiveCount < this.model.db.maxParallelQueries && this.dbQueue.size === 0) {
      run();
      return;
    }
    const waiter: Waiter = {
      active: true,
      run: () => {
        off();
        run();
      },
    };
    this.dbQueue.push(waiter);
    this.dbQueued.add(this.now, 1);
    const off = env.scope.onCancel(() => {
      this.dbQueue.remove(waiter);
      this.dbQueued.add(this.now, -1);
      if (env.req.sampled) {
        const waited = this.now - requestedAt;
        this.querySpan(env, path, step, requestedAt, activeAtRequest, waited, true);
      }
      done('cancelled');
    });
  }

  // ---- Steps --------------------------------------------------------------------------------

  private execSteps(
    env: Env,
    steps: readonly Step[],
    index: number,
    path: string,
    done: Done,
  ): void {
    if (env.scope.cancelled) {
      done('cancelled');
      return;
    }
    const step = steps[index];
    if (step === undefined) {
      done('ok');
      return;
    }
    this.execStep(env, step, childPath(path, step.label), (status) => {
      if (status === 'ok') this.execSteps(env, steps, index + 1, path, done);
      else done(status);
    });
  }

  /**
   * Runs `count` branches concurrently; branch i runs `stepsOf(i)` under path `${path}[i]`.
   * Fails fast: the first failure cancels the other branches.
   */
  private execBranches(
    env: Env,
    count: number,
    stepsOf: (i: number) => readonly Step[],
    path: string,
    done: Done,
  ): void {
    if (count === 0) {
      done('ok');
      return;
    }
    let remaining = count;
    let finished = false;
    const scopes: Scope[] = [];
    for (let i = 0; i < count && !finished; i++) {
      const scope = new Scope(env.scope);
      scopes.push(scope);
      const branchEnv: Env = {
        req: env.req,
        svc: env.svc,
        scope,
        holdsConn: false,
        parentSpanId: env.parentSpanId,
      };
      this.execSteps(branchEnv, stepsOf(i), 0, indexedPath(path, i), (status) => {
        if (finished) return;
        if (status === 'ok') {
          if (--remaining === 0) {
            finished = true;
            done('ok');
          }
          return;
        }
        finished = true;
        for (const other of scopes) if (other !== scope) other.cancel();
        done(status);
      });
    }
  }

  /** Cancellable wait (retry backoff). */
  private sleep(scope: Scope, durUs: number, done: Done): void {
    const off = scope.onCancel(() => {
      timer.cancel();
      done('cancelled');
    });
    const timer: Timer = this.heap.push(this.now + durUs, () => {
      off();
      done('ok');
    });
  }

  private execCall(env: Env, step: CallStep, path: string, attempt: number, done: Done): void {
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    this.callService(
      env.req,
      step.service,
      step.operation,
      attempt === 0 ? path : `${path}~${String(attempt)}`,
      env.parentSpanId,
      env.scope,
      attempt + 1,
      (status) => {
        if (status === 'ok' || status === 'cancelled') {
          done(status);
          return;
        }
        if (env.scope.cancelled) {
          done('cancelled');
          return;
        }
        const willRetry = attempt + 1 < maxAttempts;
        if (env.req.sampled) {
          this.log(
            env.svc.name,
            willRetry ? 'warn' : 'error',
            'downstream call failed',
            {
              target: `${step.service}.${step.operation}`,
              status,
              attempt: attempt + 1,
              willRetry,
            },
            env.req,
          );
        }
        if (!willRetry) {
          done(status);
          return;
        }
        this.sleep(env.scope, (step.retry?.backoffUs ?? 0) * 2 ** attempt, (s) => {
          if (s === 'ok') this.execCall(env, step, path, attempt + 1, done);
          else done('cancelled');
        });
      },
    );
  }

  private execExternal(env: Env, step: ExternalStep, path: string, done: Done): void {
    const startedAt = this.now;
    const durUs = this.drawUs(env, step.label, step.dist, path);
    this.heap.push(this.now + durUs, () => {
      if (env.req.sampled) {
        this.emitSpan(env.req, path, env.parentSpanId, env.svc.name, step.label, startedAt, 'ok', {
          [SPAN_ATTRS.peerService]: step.peer,
        });
        if (step.slowLogThresholdUs !== undefined && durUs > step.slowLogThresholdUs) {
          this.log(
            env.svc.name,
            'warn',
            `${step.peer} slow response`,
            { call: step.label, durationMs: round3(durUs / US_PER_MS) },
            env.req,
          );
        }
      }
      done(env.scope.cancelled ? 'cancelled' : 'ok');
    });
  }

  private execTransaction(
    env: Env,
    steps: readonly Step[],
    label: string,
    path: string,
    done: Done,
  ): void {
    this.acquire(env, childPath(path, 'acquire'), label, (acquired) => {
      if (acquired !== 'ok') {
        done(acquired);
        return;
      }
      const heldSince = this.now;
      const txEnv: Env = {
        req: env.req,
        svc: env.svc,
        scope: env.scope,
        holdsConn: true,
        parentSpanId: env.req.sampled ? spanIdFor(this.seed, env.req.id, path) : null,
      };
      this.execSteps(txEnv, steps, 0, path, (status) => {
        this.releaseConn(heldSince);
        if (env.req.sampled) {
          this.emitSpan(
            env.req,
            path,
            env.parentSpanId,
            env.svc.name,
            SPAN_NAMES.dbTransaction,
            heldSince,
            status === 'ok' ? 'ok' : 'error',
            { [SPAN_ATTRS.dbStatement]: label, outcome: status === 'ok' ? 'commit' : 'rollback' },
          );
        }
        done(status);
      });
    });
  }

  /**
   * Model variant of a transaction that does not hold its connection across downstream work.
   * Steps are split into segments: runs of DB work (queries, compute, nested transactions) hold
   * one connection each; every other step runs with no connection held. Child paths are those of
   * the plain transaction, so every random draw is the same as in the recorded model. Segment k
   * > 0 has its own acquire and db.transaction span under `<path>#k`.
   */
  private execReleasingTransaction(
    env: Env,
    steps: readonly Step[],
    label: string,
    path: string,
    done: Done,
  ): void {
    const isDbWork = (s: Step): boolean =>
      s.kind === 'query' || s.kind === 'compute' || s.kind === 'transaction' || s.kind === 'cache';
    const segments: { db: boolean; steps: Step[] }[] = [];
    for (const s of steps) {
      const last = segments.at(-1);
      if (last !== undefined && last.db === isDbWork(s)) last.steps.push(s);
      else segments.push({ db: isDbWork(s), steps: [s] });
    }
    let dbSegment = 0;
    const runSegment = (i: number): void => {
      const seg = segments[i];
      if (seg === undefined) {
        done('ok');
        return;
      }
      const next = (status: Status): void => {
        if (status === 'ok') runSegment(i + 1);
        else done(status);
      };
      if (!seg.db) {
        const free: Env = { ...env, holdsConn: false };
        this.runSteps(free, seg.steps, path, next);
        return;
      }
      const k = dbSegment++;
      const segPath = k === 0 ? path : `${path}#${String(k)}`;
      this.acquire(env, childPath(segPath, 'acquire'), label, (acquired) => {
        if (acquired !== 'ok') {
          done(acquired);
          return;
        }
        const heldSince = this.now;
        const txEnv: Env = {
          req: env.req,
          svc: env.svc,
          scope: env.scope,
          holdsConn: true,
          parentSpanId: env.req.sampled ? spanIdFor(this.seed, env.req.id, segPath) : null,
        };
        this.runSteps(txEnv, seg.steps, path, (status) => {
          this.releaseConn(heldSince);
          if (env.req.sampled) {
            this.emitSpan(
              env.req,
              segPath,
              env.parentSpanId,
              env.svc.name,
              SPAN_NAMES.dbTransaction,
              heldSince,
              status === 'ok' ? 'ok' : 'error',
              {
                [SPAN_ATTRS.dbStatement]: label,
                outcome: status === 'ok' ? 'commit' : 'rollback',
                segment: k,
              },
            );
          }
          next(status);
        });
      });
    };
    runSegment(0);
  }

  /** Cache-aside read; see CacheStep in model.ts. */
  private execCache(env: Env, step: CacheStep, path: string, done: Done): void {
    const capacity = this.model.cache?.capacity ?? 0;
    const keySpace = Math.max(1, env.svc.cfg.params[step.keySpaceParam] ?? 1);
    const id = `${env.svc.name}/${step.label}`;
    let state = this.caches.get(id);
    // The run starts with a warm cache.
    if (state === undefined)
      this.caches.set(id, (state = { entries: Math.min(capacity, keySpace), keySpace }));
    if (state.keySpace !== keySpace) {
      // New key format: nothing cached matches any more.
      state.keySpace = keySpace;
      state.entries = 0;
    }
    const cache = state;
    const hit =
      uniform(this.seed, env.req.id, `${path}#hit`) < Math.min(cache.entries, keySpace) / keySpace;
    const startedAt = this.now;
    const lookupUs = this.drawUs(env, step.label, step.lookup, path);
    this.heap.push(this.now + lookupUs, () => {
      env.svc.windowCacheLookups++;
      if (hit) env.svc.windowCacheHits++;
      if (env.req.sampled) {
        this.emitSpan(
          env.req,
          childPath(path, 'get'),
          env.parentSpanId,
          env.svc.name,
          SPAN_NAMES.cacheGet,
          startedAt,
          'ok',
          {
            [SPAN_ATTRS.cacheHit]: hit,
            [SPAN_ATTRS.dbStatement]: step.label,
          },
        );
      }
      if (hit || env.scope.cancelled) {
        done(env.scope.cancelled ? 'cancelled' : 'ok');
        return;
      }
      this.execSteps(env, step.steps, 0, path, (status) => {
        if (status === 'ok')
          cache.entries = Math.min(cache.entries + 1, this.model.cache?.capacity ?? 0, keySpace);
        done(status);
      });
    });
  }

  /** Runs `steps` in order as children of `path` (each under its own label). */
  private runSteps(env: Env, steps: readonly Step[], path: string, done: Done): void {
    this.execSteps(env, steps, 0, path, done);
  }

  private execStep(env: Env, step: Step, path: string, done: Done): void {
    switch (step.kind) {
      case 'compute': {
        const durUs = this.drawUs(env, step.label, step.dist, path);
        this.heap.push(this.now + durUs, () => {
          done(env.scope.cancelled ? 'cancelled' : 'ok');
        });
        return;
      }
      case 'external':
        this.execExternal(env, step, path, done);
        return;
      case 'query': {
        if (env.holdsConn) {
          this.dbExec(env, path, step, done);
          return;
        }
        this.acquire(env, childPath(path, 'acquire'), step.label, (acquired) => {
          if (acquired !== 'ok') {
            done(acquired);
            return;
          }
          const heldSince = this.now;
          this.dbExec(env, path, step, (status) => {
            this.releaseConn(heldSince);
            done(status);
          });
        });
        return;
      }
      case 'call':
        this.execCall(env, step, path, 0, done);
        return;
      case 'parallel':
        this.execBranches(env, step.branches.length, (i) => step.branches[i] ?? [], path, done);
        return;
      case 'fanout':
        this.execBranches(
          env,
          env.svc.cfg.params[step.countParam] ?? 0,
          () => step.steps,
          path,
          done,
        );
        return;
      case 'cache':
        this.execCache(env, step, path, done);
        return;
      case 'transaction':
        if (env.holdsConn)
          this.execSteps(env, step.steps, 0, path, done); // joins the outer one
        else if (step.release === 'around-calls')
          this.execReleasingTransaction(env, step.steps, step.label, path, done);
        else this.execTransaction(env, step.steps, step.label, path, done);
        return;
    }
  }

  // ---- Service calls ------------------------------------------------------------------------

  // ---- Pod lifecycle (services with a pod model) --------------------------------------------

  private podMemory(svc: ServiceRt, replica: Replica): number {
    const p = svc.cfg.pods;
    return p === undefined ? 0 : p.memoryBaseBytes + p.memoryPerRequestBytes * replica.busy;
  }

  private overMemory(svc: ServiceRt, replica: Replica): boolean {
    const p = svc.cfg.pods;
    return p !== undefined && this.podMemory(svc, replica) > p.memoryLimitBytes;
  }

  private podEvent(
    service: string,
    pod: string,
    reason: PodEvent['reason'],
    message: string,
  ): void {
    this.podEvents.push({
      id: `pe_${(this.podSeq++).toString(36)}`,
      ts: this.now,
      service,
      pod,
      reason,
      message,
    });
  }

  /** The pod exceeded its memory limit: everything on it fails, and it restarts after a back-off. */
  private oomKill(svc: ServiceRt, replica: Replica, index: number): void {
    const p = svc.cfg.pods;
    if (p === undefined) return;
    const pod = `${svc.name}-${String(index)}`;
    const mib = (b: number): number => Math.round(b / 1_048_576);
    const memory = this.podMemory(svc, replica);
    const killedRequests = replica.busy;
    replica.ready = false;
    svc.restarts++;
    replica.busy = 0;
    svc.inFlight.add(this.now, -killedRequests);
    this.podEvent(
      svc.name,
      pod,
      'OOMKilled',
      `Container ${svc.name} exceeded its memory limit (${String(mib(memory))} MiB of ${String(mib(p.memoryLimitBytes))} MiB) and was OOMKilled`,
    );
    this.log(svc.name, 'error', 'pod OOMKilled', {
      pod,
      memoryMiB: mib(memory),
      limitMiB: mib(p.memoryLimitBytes),
      inFlight: killedRequests,
    });
    const kills = [...replica.inflight];
    replica.inflight.clear();
    for (const kill of kills) kill();
    for (let w = replica.queue.shift(); w !== undefined; w = replica.queue.shift()) {
      svc.queueDepth.add(this.now, -1);
      w.fail?.();
    }
    if (this.now - replica.readySince >= p.backoffResetUs) replica.backoffLevel = 0;
    const backoffUs = Math.min(p.maxBackoffUs, p.restartBackoffUs * 2 ** replica.backoffLevel);
    replica.backoffLevel++;
    if (replica.backoffLevel > 1) {
      this.podEvent(
        svc.name,
        pod,
        'CrashLoopBackOff',
        `Back-off ${String(Math.round(backoffUs / US_PER_S))}s restarting failed container ${svc.name}`,
      );
    }
    this.heap.push(this.now + backoffUs, () => {
      this.podEvent(svc.name, pod, 'Restarted', `Container ${svc.name} restarted`);
      this.heap.push(this.now + p.startupUs, () => {
        replica.ready = true;
        replica.readySince = this.now;
        this.podEvent(svc.name, pod, 'Started', `Container ${svc.name} started and is ready`);
      });
    });
  }

  /** Every pod of the service is down: the request is refused at once. */
  private noReadyPod(
    req: Req,
    svc: ServiceRt,
    opName: string,
    path: string,
    parentSpanId: string | null,
    done: (status: Status, httpStatus: number) => void,
  ): void {
    svc.windowLatencies.push(0);
    svc.responses++;
    svc.windowErrors++;
    svc.errors++;
    svc.rejected++;
    svc.windowRejected++;
    if (req.sampled) {
      this.emitSpan(req, path, parentSpanId, svc.name, opName, this.now, 'error', {
        [SPAN_ATTRS.requestType]: req.type,
        [SPAN_ATTRS.httpStatus]: 503,
      });
      this.log(svc.name, 'error', 'no ready pod to serve request', { operation: opName }, req);
    }
    done('error', 503);
  }

  private pumpReplica(svc: ServiceRt, replica: Replica): void {
    while (replica.busy < svc.cfg.workers) {
      const next = replica.queue.shift();
      if (next === undefined) break;
      svc.queueDepth.add(this.now, -1);
      next.run();
    }
  }

  private callService(
    req: Req,
    svcName: string,
    opName: string,
    path: string,
    parentSpanId: string | null,
    parentScope: Scope,
    attemptNo: number,
    done: (status: Status, httpStatus: number) => void,
  ): void {
    const svc = this.services.get(svcName);
    const op = svc?.cfg.operations[opName];
    if (svc === undefined || op === undefined) {
      throw new Error(`unknown operation ${svcName}.${opName}`);
    }
    const cfg = svc.cfg;
    let replicaIndex = svc.rr % svc.replicas.length;
    if (cfg.pods !== undefined) {
      // Round-robin over READY pods only.
      replicaIndex = -1;
      for (let k = 0; k < svc.replicas.length; k++) {
        const i = (svc.rr + k) % svc.replicas.length;
        if (svc.replicas[i]?.ready === true) {
          replicaIndex = i;
          break;
        }
      }
      if (replicaIndex < 0) {
        svc.rr++;
        this.noReadyPod(req, svc, opName, path, parentSpanId, done);
        return;
      }
      svc.rr = replicaIndex;
    }
    const replica = svc.replicas[replicaIndex] as Replica;
    svc.rr++;
    const arrivedAt = this.now;
    const spanId = req.sampled ? spanIdFor(this.seed, req.id, path) : null;
    let responded = false;
    let timer: Timer | undefined = undefined; // set below; respond() may run before that
    let queued: Waiter | undefined;

    const respond = (status: Status, httpStatus: number): void => {
      if (responded) return;
      responded = true;
      timer?.cancel();
      const latencyUs = this.now - arrivedAt;
      svc.windowLatencies.push(latencyUs);
      svc.responses++;
      svc.totalLatencyUs += latencyUs;
      if (status !== 'ok') {
        svc.windowErrors++;
        svc.errors++;
      }
      if (req.sampled) {
        const attrs: Record<string, AttributeValue> = {
          [SPAN_ATTRS.requestType]: req.type,
          [SPAN_ATTRS.pod]: `${svcName}-${String(replicaIndex)}`,
          [SPAN_ATTRS.httpStatus]: httpStatus,
        };
        if (status === 'cancelled') attrs[SPAN_ATTRS.cancelled] = true;
        if (attemptNo > 1) attrs[SPAN_ATTRS.attempt] = attemptNo;
        const spanStatus = status === 'ok' ? 'ok' : status === 'timeout' ? 'timeout' : 'error';
        this.emitSpan(req, path, parentSpanId, svcName, opName, arrivedAt, spanStatus, attrs);
      }
      done(status, httpStatus);
    };

    const leaveQueue = (status: SpanStatus, cancelled: boolean): void => {
      if (queued === undefined) return;
      replica.queue.remove(queued);
      queued = undefined;
      svc.queueDepth.add(this.now, -1);
      if (req.sampled) {
        const attrs: Record<string, AttributeValue> = {};
        if (cancelled) attrs[SPAN_ATTRS.cancelled] = true;
        const queuePath = childPath(path, 'queue');
        this.emitSpan(
          req,
          queuePath,
          spanId,
          svcName,
          SPAN_NAMES.queueWait,
          arrivedAt,
          status,
          attrs,
        );
      }
    };

    // Rejected outright: no free worker and no room in the queue.
    const mustQueue = replica.busy >= cfg.workers || replica.queue.size > 0;
    if (mustQueue && replica.queue.size >= cfg.queueLimit) {
      svc.rejected++;
      svc.windowRejected++;
      respond('error', 503);
      return;
    }

    const scope = new Scope(parentScope);
    // The caller gave up: answer at once (it is no longer listening) and let the work unwind.
    scope.onCancel(() => {
      leaveQueue('error', true);
      respond('cancelled', HTTP.cancelled);
    });

    const start = (): void => {
      replica.busy++;
      svc.inFlight.add(this.now, 1);
      // Pod model: the pod can die under this request. The kill answers it at once (the
      // connection is reset) and lets its work unwind; the pod's counters were already reset.
      let killed = false;
      const kill = (): void => {
        killed = true;
        respond('error', 502);
        scope.cancel();
      };
      if (cfg.pods !== undefined) {
        replica.inflight.add(kill);
        if (this.overMemory(svc, replica)) {
          this.oomKill(svc, replica, replicaIndex);
          return;
        }
      }
      const env: Env = { req, svc, scope, holdsConn: false, parentSpanId: spanId };
      this.execSteps(env, op.steps, 0, path, (status) => {
        // All steps have unwound: every resource this handler held is already released.
        if (killed) return;
        if (cfg.pods !== undefined) replica.inflight.delete(kill);
        replica.busy--;
        svc.inFlight.add(this.now, -1);
        respond(status, HTTP[status]);
        this.pumpReplica(svc, replica);
      });
    };

    timer = this.heap.push(arrivedAt + cfg.timeoutUs, () => {
      if (responded) return;
      leaveQueue('timeout', false);
      if (req.sampled) {
        this.log(
          svcName,
          'error',
          'request exceeded deadline',
          { operation: opName, timeoutMs: Math.round(cfg.timeoutUs / US_PER_MS) },
          req,
        );
      }
      respond('timeout', HTTP.timeout);
      scope.cancel();
    });

    if (!mustQueue) {
      start();
      return;
    }
    queued = {
      active: true,
      fail: () => {
        queued = undefined; // the dying pod already removed it and adjusted the gauge
        respond('error', 503);
        scope.cancel();
      },
      run: () => {
        queued = undefined; // Fifo.shift() already removed it; the pump adjusted the gauge
        if (req.sampled) {
          const queuePath = childPath(path, 'queue');
          this.emitSpan(req, queuePath, spanId, svcName, SPAN_NAMES.queueWait, arrivedAt, 'ok', {});
        }
        start();
      },
    };
    replica.queue.push(queued);
    svc.queueDepth.add(this.now, 1);
  }

  // ---- Scheduled changes --------------------------------------------------------------------

  private applyChange(ev: ChangeEvent): void {
    // Knobs a counterfactual patch pinned keep their value; the event records that it did not
    // apply them, so replayed telemetry never shows a diff that did not happen.
    const pinned: Record<string, number> = {};
    for (const [key, d] of Object.entries(ev.diff)) {
      const target = `${ev.service}.${key}`;
      if (!this.pins.has(target) || typeof d.to !== 'number') continue;
      const held = getKnob(this.model, target);
      if (held !== undefined) pinned[key] = held;
    }
    const pinnedKeys = Object.keys(pinned);
    this.changeEvents.push(pinnedKeys.length === 0 ? ev : { ...ev, pinned });
    const fields: Record<string, AttributeValue> = { changeId: ev.id };
    for (const [key, d] of Object.entries(ev.diff)) {
      fields[key] =
        pinned[key] === undefined
          ? `${String(d.from)} -> ${String(d.to)}`
          : `pinned at ${String(pinned[key])} (not applied: ${String(d.from)} -> ${String(d.to)})`;
    }
    this.log(ev.service, 'info', `${ev.kind} applied: ${ev.description}`, fields);
    for (const [key, d] of Object.entries(ev.diff)) {
      const target = `${ev.service}.${key}`;
      if (this.pins.has(target) || typeof d.to !== 'number') continue;
      setKnob(this.model, target, d.to);
    }
    // Capacity may have grown: let waiting work proceed.
    for (const svc of this.services.values()) {
      for (const replica of svc.replicas) this.pumpReplica(svc, replica);
    }
    this.pumpPool();
    this.pumpDb();
  }

  // ---- Metrics ------------------------------------------------------------------------------

  private point(service: string, name: MetricName, value: number): void {
    this.metrics.push({ ts: this.now, service, name, value: round3(value), labels: {} });
  }

  /** Samples every metric (brief §2). Gauges are point samples; rates and percentiles cover the window. */
  private readonly metricTick = (): void => {
    const windowSecs = this.metricIntervalUs / US_PER_S;
    for (const svc of this.services.values()) {
      const n = svc.windowLatencies.length;
      this.point(svc.name, 'request_rate', n / windowSecs);
      if (n > 0) {
        const sorted = Float64Array.from(svc.windowLatencies).sort();
        this.point(svc.name, 'error_rate', svc.windowErrors / n);
        this.point(svc.name, 'latency_p50', percentileSorted(sorted, 0.5));
        this.point(svc.name, 'latency_p95', percentileSorted(sorted, 0.95));
        this.point(svc.name, 'latency_p99', percentileSorted(sorted, 0.99));
      }
      this.point(svc.name, 'in_flight', svc.inFlight.value);
      this.point(svc.name, 'queue_depth', svc.queueDepth.value);
      if (svc.hasCache && svc.windowCacheLookups > 0) {
        this.point(svc.name, 'cache_hit_ratio', svc.windowCacheHits / svc.windowCacheLookups);
      }
      svc.windowCacheLookups = 0;
      svc.windowCacheHits = 0;
      if (svc.cfg.pods !== undefined) {
        let ready = 0;
        let memory = 0;
        for (const r of svc.replicas) {
          if (!r.ready) continue;
          ready++;
          memory = Math.max(memory, this.podMemory(svc, r));
        }
        this.point(svc.name, 'replicas_ready', ready);
        this.point(svc.name, 'pod_restarts', svc.restarts);
        this.point(svc.name, 'memory_working_set', memory);
      }
      if (svc.windowRejected > 0) {
        this.log(
          svc.name,
          'warn',
          `rejected ${String(svc.windowRejected)} requests in last ${String(windowSecs)}s: queue full`,
          { rejected: svc.windowRejected, queueLimit: svc.cfg.queueLimit },
        );
      }
      svc.windowLatencies = [];
      svc.windowErrors = 0;
      svc.windowRejected = 0;
    }
    this.point(DB_SERVICE, 'request_rate', this.windowQueries / windowSecs);
    this.point(DB_SERVICE, 'pool_in_use', this.poolInUse.value);
    this.point(DB_SERVICE, 'pool_capacity', this.model.db.pool.capacity);
    this.point(DB_SERVICE, 'pool_wait_queue', this.poolWaiting.value);
    this.point(DB_SERVICE, 'db_active_queries', this.dbActive.value);
    this.point(DB_SERVICE, 'queue_depth', this.dbQueued.value);
    if (this.windowExec.length > 0) {
      const sorted = Float64Array.from(this.windowExec).sort();
      this.point(DB_SERVICE, 'query_exec_p95', percentileSorted(sorted, 0.95));
    }
    this.windowExec = [];
    this.windowQueries = 0;
    if (this.now + this.metricIntervalUs <= this.durationUs) {
      this.heap.push(this.now + this.metricIntervalUs, this.metricTick);
    }
  };

  // ---- Background noise logs ----------------------------------------------------------------

  private scheduleNoise(meanIntervalUs: number): void {
    for (const service of [...this.services.keys(), DB_SERVICE]) {
      const next = mulberry32(hashString(`noise/${service}`, this.seed));
      const catalog = service === DB_SERVICE ? DB_NOISE : NOISE;
      let t = 0;
      for (;;) {
        t += Math.max(1, Math.round(-Math.log(1 - next()) * meanIntervalUs));
        if (t > this.durationUs) break;
        const entry = catalog[Math.floor(next() * catalog.length)] as (typeof catalog)[number];
        const value = 1 + Math.floor(next() * entry.max);
        this.heap.push(t, () => {
          this.log(service, entry.level, entry.message, { [entry.field]: value });
        });
      }
    }
  }

  // ---- Arrivals -----------------------------------------------------------------------------

  private readonly arrive = (): void => {
    const requests = this.workload.requests;
    const r = requests[this.nextArrival++];
    if (r === undefined) return;
    const following = requests[this.nextArrival];
    if (following !== undefined) {
      if (following.arrivalUs < r.arrivalUs)
        throw new Error('workload must be sorted by arrivalUs');
      this.heap.push(following.arrivalUs, this.arrive);
    }
    const entry = this.model.requestTypes[r.type];
    if (entry === undefined) {
      throw new Error(`workload request type "${r.type}" is not in the model`);
    }
    const req: Req = {
      id: r.requestId,
      type: r.type,
      sampled: uniform(this.seed, r.requestId, 'trace-sample') < this.traceSampleRate,
      traceId: null,
    };
    this.callService(
      req,
      entry.service,
      entry.operation,
      r.type,
      null,
      new Scope(),
      1,
      (status, httpStatus) => {
        this.requestsFinished++;
        this.outcomes.push({
          requestId: r.requestId,
          type: r.type,
          arrivalUs: r.arrivalUs,
          endUs: this.now,
          status: status === 'ok' ? 'ok' : status === 'timeout' ? 'timeout' : 'error',
          httpStatus,
        });
        if (req.sampled) {
          this.log(
            entry.service,
            httpStatus >= 500 ? 'error' : 'info',
            `${r.type} ${String(httpStatus)}`,
            {
              route: r.type,
              status: httpStatus,
              durationMs: round3((this.now - r.arrivalUs) / US_PER_MS),
            },
            req,
          );
        }
      },
    );
  };

  // ---- Run ----------------------------------------------------------------------------------

  run(): SimResult {
    for (const ev of this.config.changes) {
      this.heap.push(ev.ts, () => {
        this.applyChange(ev);
      });
    }
    if (this.metricIntervalUs <= this.durationUs) {
      this.heap.push(this.metricIntervalUs, this.metricTick);
    }
    if (this.config.options.noiseLogMeanIntervalUs > 0) {
      this.scheduleNoise(this.config.options.noiseLogMeanIntervalUs);
    }
    const first = this.workload.requests[0];
    if (first !== undefined) this.heap.push(first.arrivalUs, this.arrive);

    let eventsProcessed = 0;
    for (;;) {
      const ev = this.heap.pop();
      if (ev === undefined || ev.t > this.durationUs) break;
      const fn = ev.fn;
      if (fn === null) continue;
      this.now = ev.t;
      eventsProcessed++;
      fn();
    }
    this.now = this.durationUs;

    // Waits still pending at the end count up to the end of the run.
    for (const w of this.poolQueue.live()) {
      this.poolStats.totalAcquireWaitUs += this.now - w.startTs;
    }
    return this.result(eventsProcessed);
  }

  private result(eventsProcessed: number): SimResult {
    // Drop traces the run cut off (no root span yet, or a parent that never finished), and the
    // request-scoped logs that point at them, so every traceId in the output resolves to a trace.
    const byTrace = new Map<string, Span[]>();
    for (const s of this.spans) {
      const list = byTrace.get(s.traceId);
      if (list === undefined) byTrace.set(s.traceId, [s]);
      else list.push(s);
    }
    const truncated = new Set<string>();
    for (const [traceId, list] of byTrace) {
      const ids = new Set(list.map((s) => s.spanId));
      const complete =
        list.some((s) => s.parentSpanId === null) &&
        list.every((s) => s.parentSpanId === null || ids.has(s.parentSpanId));
      if (!complete) truncated.add(traceId);
    }
    const spans =
      truncated.size === 0 ? this.spans : this.spans.filter((s) => !truncated.has(s.traceId));
    const logs = this.logs.filter(
      (l) => l.traceId === undefined || (byTrace.has(l.traceId) && !truncated.has(l.traceId)),
    );

    let busyWorkers = 0;
    let queuedRequests = 0;
    const serviceStats: SimStats['services'] = {};
    const serviceAverages: SimStats['timeAverages']['services'] = {};
    for (const svc of this.services.values()) {
      for (const replica of svc.replicas) {
        busyWorkers += replica.busy;
        queuedRequests += replica.queue.size;
      }
      serviceAverages[svc.name] = {
        inFlight: svc.inFlight.mean(this.now),
        queueDepth: svc.queueDepth.mean(this.now),
      };
      serviceStats[svc.name] = {
        responses: svc.responses,
        errors: svc.errors,
        rejected: svc.rejected,
        totalLatencyUs: svc.totalLatencyUs,
      };
    }

    const result: SimResult = {
      telemetry: {
        spans,
        logs,
        metrics: this.metrics,
        changeEvents: this.changeEvents,
        podEvents: this.podEvents,
      },
      outcomes: this.outcomes,
      stats: {
        eventsProcessed,
        requestsArrived: this.nextArrival,
        requestsFinished: this.requestsFinished,
        requestsUnfinished: this.nextArrival - this.requestsFinished,
        tracesTruncated: truncated.size,
        pool: this.poolStats,
        db: this.dbStats,
        services: serviceStats,
        timeAverages: {
          poolInUse: this.poolInUse.mean(this.now),
          poolWaiting: this.poolWaiting.mean(this.now),
          dbActive: this.dbActive.mean(this.now),
          dbQueued: this.dbQueued.mean(this.now),
          services: serviceAverages,
        },
        finalState: {
          poolInUse: this.poolInUseCount,
          poolWaiting: this.poolQueue.size,
          dbActive: this.dbActiveCount,
          dbQueued: this.dbQueue.size,
          busyWorkers,
          queuedRequests,
        },
      },
    };
    if (this.draws !== undefined) result.draws = this.draws;
    return result;
  }
}

function hasCacheStep(steps: readonly Step[]): boolean {
  return steps.some(
    (s) =>
      s.kind === 'cache' ||
      (s.kind === 'parallel' && s.branches.some(hasCacheStep)) ||
      ((s.kind === 'fanout' || s.kind === 'transaction') && hasCacheStep(s.steps)),
  );
}

/** Trace ids are derived lazily: most requests are not sampled and never need one. */
function traceOf(seed: number, req: Req): string {
  return (req.traceId ??= traceIdFor(seed, req.id));
}

/** Runs `workload` against `config`. Pure: same inputs ⇒ byte-identical output. */
export function runSimulation(
  config: SimConfig,
  workload: Workload,
  opts: RunOptions = {},
): SimResult {
  return new Simulation(config, workload, opts).run();
}
