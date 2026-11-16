// Engine mechanics on tiny models with constant durations, so every expected time is exact.
import { SPAN_ATTRS, SPAN_NAMES, type Span } from '@tracepilot/schema';
import { describe, expect, it } from 'vitest';
import type { SimResult } from './engine.ts';
import { findTelemetryProblems } from './summary.ts';
import { ends, fixed, ms, runMicro, service } from './testkit.ts';

const spansNamed = (r: SimResult, name: string): Span[] =>
  r.telemetry.spans.filter((s) => s.name === name).sort((a, b) => a.startUs - b.startUs);
const dur = (s: Span): number => (s.endUs - s.startUs) / 1000;
const drained = {
  poolInUse: 0,
  poolWaiting: 0,
  dbActive: 0,
  dbQueued: 0,
  busyWorkers: 0,
  queuedRequests: 0,
};

describe('connection pool', () => {
  const api = service([{ kind: 'query', label: 'q', dist: fixed(10) }]);

  it('serves waiters in FIFO order', () => {
    const r = runMicro({ services: { api }, pool: 1 }, [0, 1, 2]);
    expect(ends(r)).toEqual([
      [10, 'ok'],
      [20, 'ok'],
      [30, 'ok'],
    ]);
    const acquires = spansNamed(r, SPAN_NAMES.poolAcquire);
    expect(acquires.map(dur)).toEqual([0, 9, 18]);
    expect(acquires.map((s) => s.attributes[SPAN_ATTRS.poolInUseAtAcquire])).toEqual([0, 1, 1]);
    expect(acquires.map((s) => s.attributes[SPAN_ATTRS.poolWaitQueueAtAcquire])).toEqual([0, 0, 1]);
    expect(acquires.every((s) => s.attributes[SPAN_ATTRS.poolCapacity] === 1)).toBe(true);
    expect(r.stats.pool.totalAcquireWaitUs).toBe(ms(27));
    expect(r.stats.pool.totalHoldUs).toBe(ms(30));
    expect(r.stats.finalState).toEqual(drained);
    expect(findTelemetryProblems(r.telemetry)).toEqual([]);
  });

  it('times out an acquire, logs it, and fails the request', () => {
    const slow = service([{ kind: 'query', label: 'q', dist: fixed(100) }]);
    const r = runMicro({ services: { api: slow }, pool: 1, acquireTimeoutMs: 30 }, [0, 10]);
    expect(ends(r)).toEqual([
      [100, 'ok'],
      [40, 'error'],
    ]);
    const timedOut = spansNamed(r, SPAN_NAMES.poolAcquire).find((s) => s.status === 'timeout');
    expect(timedOut && dur(timedOut)).toBe(30);
    expect(r.stats.pool.acquireTimeouts).toBe(1);
    const log = r.telemetry.logs.find((l) => l.message.startsWith('timeout acquiring connection'));
    expect(log?.message).toBe('timeout acquiring connection after 30ms');
    expect(log?.level).toBe('error');
    expect(log?.ts).toBe(ms(40));
    expect(r.outcomes.find((o) => o.requestId === 1)?.httpStatus).toBe(500);
    expect(r.stats.finalState).toEqual(drained);
  });

  it('a larger pool removes the wait without changing execution time', () => {
    const r = runMicro({ services: { api }, pool: 3 }, [0, 1, 2]);
    expect(ends(r)).toEqual([
      [10, 'ok'],
      [11, 'ok'],
      [12, 'ok'],
    ]);
    expect(r.stats.pool.totalAcquireWaitUs).toBe(0);
    expect(spansNamed(r, SPAN_NAMES.dbQuery).map(dur)).toEqual([10, 10, 10]);
  });
});

describe('DB executor', () => {
  it('queues queries beyond maxParallelQueries while their connection stays held', () => {
    const api = service([{ kind: 'query', label: 'q', dist: fixed(10) }]);
    const r = runMicro({ services: { api }, pool: 2, maxParallelQueries: 1 }, [0, 1]);
    expect(ends(r)).toEqual([
      [10, 'ok'],
      [20, 'ok'],
    ]);
    // Both got a connection at once: the wait moved from the pool to the DB.
    expect(spansNamed(r, SPAN_NAMES.poolAcquire).map(dur)).toEqual([0, 0]);
    const queries = spansNamed(r, SPAN_NAMES.dbQuery);
    expect(queries.map(dur)).toEqual([10, 19]);
    expect(queries.map((s) => s.attributes[SPAN_ATTRS.dbQueueWaitUs])).toEqual([0, ms(9)]);
    expect(r.stats.db.totalQueueWaitUs).toBe(ms(9));
    expect(r.stats.db.totalExecUs).toBe(ms(20));
    expect(r.stats.pool.totalHoldUs).toBe(ms(10 + 19));
  });
});

describe('workers, queues and replicas', () => {
  const work = (over = {}) => service([{ kind: 'compute', label: 'work', dist: fixed(10) }], over);

  it('queues when workers are busy and rejects with 503 when the queue is full', () => {
    const r = runMicro({ services: { api: work({ workers: 1, queueLimit: 1 }) } }, [0, 1, 2]);
    expect(ends(r)).toEqual([
      [10, 'ok'],
      [20, 'ok'],
      [2, 'error'],
    ]);
    expect(r.outcomes.find((o) => o.requestId === 2)?.httpStatus).toBe(503);
    const waits = spansNamed(r, SPAN_NAMES.queueWait);
    expect(waits.map(dur)).toEqual([9]);
    expect(r.stats.services['api']?.rejected).toBe(1);
  });

  it('balances replicas round-robin, each with its own workers', () => {
    const r = runMicro(
      { services: { api: work({ replicas: 2, workers: 1, queueLimit: 0 }) } },
      [0, 1, 2],
    );
    expect(ends(r)).toEqual([
      [10, 'ok'],
      [11, 'ok'],
      [2, 'error'], // back on replica 0, which is busy and has no queue
    ]);
    const pods = r.telemetry.spans
      .filter((s) => s.name === 'op')
      .map((s) => s.attributes[SPAN_ATTRS.pod]);
    expect(new Set(pods)).toEqual(new Set(['api-0', 'api-1']));
  });

  it('enforces the service deadline for running and queued requests and frees the worker', () => {
    const api = service([{ kind: 'compute', label: 'work', dist: fixed(50) }], {
      workers: 1,
      queueLimit: 5,
      timeoutUs: ms(30),
    });
    const r = runMicro({ services: { api } }, [0, 5, 40]);
    expect(ends(r)).toEqual([
      [30, 'timeout'], // running: answered at the deadline, the worker stays busy until 50
      [35, 'timeout'], // never got a worker
      [70, 'timeout'], // started at 50 when the worker was finally free
    ]);
    expect(r.outcomes.every((o) => o.httpStatus === 504)).toBe(true);
    expect(r.telemetry.logs.filter((l) => l.message === 'request exceeded deadline')).toHaveLength(
      3,
    );
    expect(spansNamed(r, SPAN_NAMES.queueWait).map((s) => [dur(s), s.status])).toEqual([
      [30, 'timeout'],
      [10, 'ok'],
    ]);
    expect(r.stats.finalState).toEqual(drained);
  });
});

describe('transactions (hold-and-wait)', () => {
  const b = service([{ kind: 'query', label: 'q', dist: fixed(10) }]);
  const a = service([
    {
      kind: 'transaction',
      label: 'tx',
      steps: [{ kind: 'call', label: 'b', service: 'b', operation: 'op' }],
    },
  ]);

  it('keeps its connection while a downstream call needs another one', () => {
    const ok = runMicro({ services: { a, b }, pool: 2 }, [0]);
    expect(ends(ok)).toEqual([[10, 'ok']]);
    const tx = spansNamed(ok, SPAN_NAMES.dbTransaction);
    expect(tx.map((s) => [dur(s), s.status, s.attributes['outcome']])).toEqual([
      [10, 'ok', 'commit'],
    ]);
    expect(ok.stats.pool.totalHoldUs).toBe(ms(20)); // two connections for 10 ms each
  });

  it('starves itself when the pool has no connection left for the downstream call', () => {
    const r = runMicro({ services: { a, b }, pool: 1, acquireTimeoutMs: 30 }, [0]);
    expect(ends(r)).toEqual([[30, 'error']]);
    expect(
      spansNamed(r, SPAN_NAMES.dbTransaction).map((s) => [
        dur(s),
        s.status,
        s.attributes['outcome'],
      ]),
    ).toEqual([[30, 'error', 'rollback']]);
    expect(r.stats.pool.acquireTimeouts).toBe(1);
    expect(r.stats.finalState).toEqual(drained);
  });

  it('runs its own queries on the held connection', () => {
    const svc = service([
      {
        kind: 'transaction',
        label: 'tx',
        steps: [
          { kind: 'query', label: 'q1', dist: fixed(5) },
          { kind: 'query', label: 'q2', dist: fixed(5) },
        ],
      },
    ]);
    const r = runMicro({ services: { svc }, pool: 1 }, [0]);
    expect(ends(r)).toEqual([[10, 'ok']]);
    expect(r.stats.pool.acquireCount).toBe(1);
    expect(r.stats.db.queryCount).toBe(2);
  });
});

describe('parallel branches and cancellation', () => {
  it('fails fast, cancels siblings, and abandoned work still releases its resources', () => {
    const root = service([
      {
        kind: 'parallel',
        label: 'both',
        branches: [
          [{ kind: 'call', label: 'slow', service: 'slow', operation: 'op' }],
          [{ kind: 'call', label: 'strict', service: 'strict', operation: 'op' }],
        ],
      },
    ]);
    const slow = service([{ kind: 'compute', label: 'work', dist: fixed(100) }]);
    const strict = service([{ kind: 'compute', label: 'work', dist: fixed(50) }], {
      timeoutUs: ms(5),
    });
    const r = runMicro({ services: { root, slow, strict } }, [0]);
    expect(ends(r)).toEqual([[5, 'timeout']]);
    const slowSpan = r.telemetry.spans.find((s) => s.service === 'slow');
    expect(
      slowSpan && [dur(slowSpan), slowSpan.status, slowSpan.attributes[SPAN_ATTRS.cancelled]],
    ).toEqual([5, 'error', true]);
    expect(r.stats.finalState).toEqual(drained);
    expect(findTelemetryProblems(r.telemetry)).toEqual([]);
  });

  it('removes a cancelled waiter from the pool queue so it never takes a connection', () => {
    // req0 holds the only connection for 100 ms. req1 waits for it but its service gives up at 20 ms.
    const api = service([{ kind: 'query', label: 'q', dist: fixed(100) }], { timeoutUs: ms(120) });
    const hasty = service([{ kind: 'call', label: 'api', service: 'api', operation: 'op' }], {
      timeoutUs: ms(20),
    });
    const cfg = { services: { hasty, api }, pool: 1, entry: 'api' };
    const direct = runMicro(cfg, [0]);
    expect(ends(direct)).toEqual([[100, 'ok']]);
    const r = runMicro({ ...cfg, entry: 'hasty' }, [0, 1]);
    expect(ends(r)).toEqual([
      [20, 'timeout'], // gave up while its query was RUNNING: the query still finishes at 100
      [21, 'timeout'], // gave up while WAITING for a connection: leaves the queue at once
    ]);
    const cancelled = spansNamed(r, SPAN_NAMES.poolAcquire).find(
      (s) => s.attributes[SPAN_ATTRS.cancelled] === true,
    );
    expect(cancelled && dur(cancelled)).toBe(20);
    expect(r.stats.db.queryCount).toBe(1);
    expect(r.stats.pool.totalHoldUs).toBe(ms(100));
    expect(r.stats.finalState).toEqual(drained);
  });
});

describe('retries', () => {
  it('retries a failed call with exponential backoff', () => {
    const flaky = service([{ kind: 'compute', label: 'work', dist: fixed(25) }], {
      workers: 1,
      queueLimit: 0,
    });
    const caller = service([
      {
        kind: 'call',
        label: 'flaky',
        service: 'flaky',
        operation: 'op',
        retry: { maxAttempts: 3, backoffUs: ms(10) },
      },
    ]);
    // Request 0 occupies flaky's only worker until 25 ms. Request 1 calls it at 1, 11 and 31 ms.
    const r = runMicro({ services: { caller, flaky }, entry: 'caller' }, [0, 1]);
    expect(ends(r)).toEqual([
      [25, 'ok'],
      [56, 'ok'],
    ]);
    const attempts = r.telemetry.spans
      .filter(
        (s) =>
          s.service === 'flaky' &&
          s.traceId === r.telemetry.spans.find((x) => x.endUs === ms(56))?.traceId,
      )
      .sort((x, y) => x.startUs - y.startUs);
    expect(
      attempts.map((s) => [s.startUs / 1000, s.status, s.attributes[SPAN_ATTRS.attempt]]),
    ).toEqual([
      [1, 'error', undefined],
      [11, 'error', 2],
      [31, 'ok', 3],
    ]);
    const retryLogs = r.telemetry.logs.filter((l) => l.message === 'downstream call failed');
    expect(retryLogs.map((l) => [l.level, l.fields['willRetry']])).toEqual([
      ['warn', true],
      ['warn', true],
    ]);
  });

  it('gives up after maxAttempts', () => {
    const flaky = service([{ kind: 'compute', label: 'work', dist: fixed(500) }], {
      workers: 1,
      queueLimit: 0,
    });
    const caller = service([
      {
        kind: 'call',
        label: 'flaky',
        service: 'flaky',
        operation: 'op',
        retry: { maxAttempts: 2, backoffUs: ms(10) },
      },
    ]);
    const r = runMicro({ services: { caller, flaky }, entry: 'caller' }, [0, 1]);
    expect(ends(r)[1]).toEqual([11, 'error']);
  });
});

describe('scheduled changes, pins and disturbances', () => {
  const api = service([{ kind: 'compute', label: 'work', dist: fixed(100) }], {
    workers: 1,
    queueLimit: 5,
  });
  const change = {
    id: 'ev_1',
    ts: ms(50),
    kind: 'config' as const,
    service: 'api',
    description: 'more workers',
    diff: { workers: { from: 1, to: 2 }, note: { from: 'a', to: 'b' } },
  };

  it('applies knob changes at their time and lets queued work proceed', () => {
    const r = runMicro({ services: { api }, changes: [change] }, [0, 10]);
    expect(ends(r)).toEqual([
      [100, 'ok'],
      [150, 'ok'], // dequeued at 50 when the second worker appeared
    ]);
    expect(r.telemetry.changeEvents).toEqual([change]);
    expect(r.telemetry.logs.some((l) => l.message === 'config applied: more workers')).toBe(true);
  });

  it('does not apply a pinned knob, and the recorded event says so', () => {
    const r = runMicro({ services: { api }, changes: [change], pins: ['api.workers'] }, [0, 10]);
    expect(ends(r)[1]).toEqual([200, 'ok']);
    // The diff is kept as it was recorded; `pinned` names the key that did not apply and the
    // value the knob stayed at. Informational keys (note) are never pinned.
    expect(r.telemetry.changeEvents).toEqual([{ ...change, pinned: { workers: 1 } }]);
    const log = r.telemetry.logs.find((l) => l.message === 'config applied: more workers');
    expect(log?.fields).toMatchObject({
      workers: 'pinned at 1 (not applied: 1 -> 2)',
      note: 'a -> b',
    });
    expect(findTelemetryProblems(r.telemetry)).toEqual([]);
  });

  it('scales a step only inside the disturbance window', () => {
    const fast = service([{ kind: 'compute', label: 'work', dist: fixed(10) }]);
    const disturbance = {
      description: 'slow',
      startUs: ms(100),
      endUs: ms(200),
      service: 'fast',
      step: 'work',
      factor: 4,
    };
    const r = runMicro({ services: { fast }, disturbances: [disturbance] }, [0, 150, 300]);
    expect(ends(r).map(([end]) => end)).toEqual([10, 190, 310]);
  });
});

describe('fan-out', () => {
  it('runs N copies concurrently and each copy needs its own connection', () => {
    const leaf = service([{ kind: 'query', label: 'q', dist: fixed(10) }]);
    const root = service(
      [
        {
          kind: 'fanout',
          label: 'fan',
          countParam: 'n',
          steps: [{ kind: 'call', label: 'leaf', service: 'leaf', operation: 'op' }],
        },
      ],
      { params: { n: 4 } },
    );
    const wide = runMicro({ services: { root, leaf }, pool: 4 }, [0]);
    expect(ends(wide)).toEqual([[10, 'ok']]);
    const narrow = runMicro({ services: { root, leaf }, pool: 2 }, [0]);
    expect(ends(narrow)).toEqual([[20, 'ok']]);
    expect(narrow.stats.pool.totalAcquireWaitUs).toBe(ms(20));
  });
});

describe('end of run', () => {
  it('reports unfinished requests and never emits a span with a missing parent', () => {
    const api = service([{ kind: 'query', label: 'q', dist: fixed(100) }]);
    const r = runMicro({ services: { api }, durationMs: 50 }, [0, 10]);
    expect(r.outcomes).toEqual([]);
    expect(r.stats.requestsArrived).toBe(2);
    expect(r.stats.requestsUnfinished).toBe(2);
    expect(findTelemetryProblems(r.telemetry)).toEqual([]);
    expect(r.telemetry.spans).toEqual([]);
  });
});
