// Pod lifecycle model (brief §5, Scenario D) on hand-checkable micro models. Each pod's memory is
// base + perRequest × requests in progress; over the limit it is OOMKilled and restarts after a
// back-off. Timings are exact (constant durations).

import { describe, expect, it } from 'vitest';
import type { PodModel } from './model.ts';
import { findTelemetryProblems, metricSeries } from './summary.ts';
import { ends, fixed, ms, runMicro, service } from './testkit.ts';

const MiB = 1_048_576;
const pods = (over: Partial<PodModel> = {}): PodModel => ({
  memoryBaseBytes: 100 * MiB,
  memoryPerRequestBytes: 50 * MiB,
  memoryLimitBytes: 210 * MiB, // two requests fit (200 MiB), a third kills the pod
  restartBackoffUs: ms(1_000),
  maxBackoffUs: ms(8_000),
  startupUs: ms(500),
  backoffResetUs: ms(60_000),
  ...over,
});
const api = (over: Partial<PodModel> = {}, replicas = 1) =>
  service([{ kind: 'compute', label: 'work', dist: fixed(100) }], {
    replicas,
    workers: 10,
    pods: pods(over),
  });

describe('pod lifecycle', () => {
  it('kills a pod that exceeds its memory limit; its in-flight requests fail at once', () => {
    // Three requests at once on one pod: the third pushes it to 250 MiB > 210 MiB.
    const r = runMicro({ services: { api: api() } }, [0, 0, 0]);
    expect(ends(r)).toEqual([
      [0, 'error'],
      [0, 'error'],
      [0, 'error'],
    ]);
    expect(r.outcomes.map((o) => o.httpStatus)).toEqual([502, 502, 502]);
    expect(r.telemetry.podEvents.map((e) => [e.ts / 1000, e.pod, e.reason])).toEqual([
      [0, 'api-0', 'OOMKilled'],
      [1_000, 'api-0', 'Restarted'], // after the 1 s back-off
      [1_500, 'api-0', 'Started'], // ready after 0.5 s startup
    ]);
    expect(r.telemetry.podEvents[0]?.message).toMatch(
      /exceeded its memory limit \(250 MiB of 210 MiB\)/,
    );
    expect(
      r.telemetry.logs.some((l) => l.message === 'pod OOMKilled' && l.fields['inFlight'] === 3),
    ).toBe(true);
    expect(findTelemetryProblems(r.telemetry)).toEqual([]);
  });

  it('within the limit nothing happens', () => {
    const r = runMicro({ services: { api: api() } }, [0, 0, 200]);
    expect(ends(r)).toEqual([
      [100, 'ok'],
      [100, 'ok'],
      [300, 'ok'],
    ]);
    expect(r.telemetry.podEvents).toEqual([]);
  });

  it('a dead pod takes no traffic; with none ready requests get 503 at once, then service resumes', () => {
    const r = runMicro({ services: { api: api() } }, [0, 0, 0, 400, 1_600]);
    expect(ends(r).slice(3)).toEqual([
      [400, 'error'], // pod down
      [1_700, 'ok'], // ready again from 1.5 s
    ]);
    expect(r.outcomes.find((o) => o.requestId === 3)?.httpStatus).toBe(503);
    expect(r.telemetry.logs.some((l) => l.message === 'no ready pod to serve request')).toBe(true);
  });

  it('routes around a dead pod to the ready ones', () => {
    // Two pods. Requests 0-2 go round-robin 0,1,0 … pod 0 gets two, pod 1 one: nobody dies.
    // Then two more: pod 0 gets its third and dies. A request after pod 1 is free again goes to
    // pod 1, the only ready one.
    const r = runMicro({ services: { api: api({}, 2) } }, [0, 0, 0, 0, 0, 150]);
    const killed = r.telemetry.podEvents.filter((e) => e.reason === 'OOMKilled').map((e) => e.pod);
    expect(killed).toEqual(['api-0']);
    expect(ends(r)[5]).toEqual([250, 'ok']); // served by api-1
  });

  it('backs off exponentially on consecutive kills and reports CrashLoopBackOff', () => {
    // Kill at 0, ready at 1.5 s; killed again at 2 s: back-off doubles to 2 s.
    const r = runMicro({ services: { api: api() } }, [0, 0, 0, 2_000, 2_000, 2_000]);
    expect(r.telemetry.podEvents.map((e) => [e.ts / 1000, e.reason])).toEqual([
      [0, 'OOMKilled'],
      [1_000, 'Restarted'],
      [1_500, 'Started'],
      [2_000, 'OOMKilled'],
      [2_000, 'CrashLoopBackOff'],
      [4_000, 'Restarted'],
      [4_500, 'Started'],
    ]);
    expect(r.telemetry.podEvents[4]?.message).toMatch(
      /Back-off 2s restarting failed container api/,
    );
  });

  it('exports replicas_ready, pod_restarts and memory_working_set', () => {
    const r = runMicro({ services: { api: api({}, 2) }, durationMs: 10_000 }, [0, 0, 0, 0, 0, 0]);
    const ready = metricSeries(r.telemetry.metrics, 'api', 'replicas_ready').map((p) => p.value);
    const restarts = metricSeries(r.telemetry.metrics, 'api', 'pod_restarts').map((p) => p.value);
    expect(ready.every((v) => v === 2)).toBe(true); // back by the first sample at 5 s
    // The sixth request lands on the only pod left and kills it too: the cascade.
    expect(restarts.at(-1)).toBe(2);
    expect(
      metricSeries(r.telemetry.metrics, 'api', 'memory_working_set').map((p) => p.value),
    ).toEqual(ready.map(() => 100 * MiB));
  });

  it('memoryLimit and memoryPerRequest are knobs; a change event can raise the per-request memory', () => {
    const svc = api({ memoryPerRequestBytes: 10 * MiB });
    const change = {
      id: 'ev_1',
      ts: ms(1_000),
      kind: 'rollout' as const,
      service: 'api',
      description: 'heavier requests',
      diff: { memoryPerRequest: { from: 10 * MiB, to: 50 * MiB } },
    };
    const before = runMicro(
      { services: { api: svc }, changes: [change] },
      [0, 0, 0, 2_000, 2_000, 2_000],
    );
    expect(before.telemetry.podEvents.map((e) => [e.ts / 1000, e.reason])[0]).toEqual([
      2_000,
      'OOMKilled',
    ]);
    // Pinning the per-request memory, or a larger limit, prevents it.
    const pinned = runMicro(
      { services: { api: svc }, changes: [change], pins: ['api.memoryPerRequest'] },
      [0, 0, 0, 2_000, 2_000, 2_000],
    );
    expect(pinned.telemetry.podEvents).toEqual([]);
    const roomy = runMicro(
      {
        services: { api: api({ memoryPerRequestBytes: 10 * MiB, memoryLimitBytes: 400 * MiB }) },
        changes: [change],
      },
      [0, 0, 0, 2_000, 2_000, 2_000],
    );
    expect(roomy.telemetry.podEvents).toEqual([]);
  });
});
