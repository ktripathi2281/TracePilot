import { describe, expect, it } from 'vitest';
import { detectAnomalies, scanAnomalies, type Anomaly } from './anomaly.ts';
import { metricEvidenceId } from '@tracepilot/schema';
import { at, noise, series, TICK } from './testkit.ts';

const BASE = { fromUs: at(0), toUs: at(60) };
const run = (
  values: number[],
  name: Parameters<typeof series>[1] = 'latency_p99',
  service = 'svc',
) => {
  const r = detectAnomalies(series(service, name, values), { baseline: BASE });
  if (!Array.isArray(r)) throw new Error(r.reason);
  return r;
};
/** 60 baseline samples around `level` with noise, then `tail`. */
const withTail = (level: number, amp: number, tail: number[], seed = 1): number[] => [
  ...noise(60, seed, amp).map((n) => level + n),
  ...tail,
];

describe('anomaly detector: negative and noisy cases', () => {
  it('flags nothing on a stationary noisy series', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(
        run(
          withTail(
            100_000,
            20_000,
            noise(60, seed + 100, 20_000).map((n) => 100_000 + n),
            seed,
          ),
        ),
      ).toEqual([]);
    }
  });

  it('never flags a single-sample spike, however large', () => {
    const tail = noise(30, 9, 2).map((n) => 12 + n);
    tail[10] = 30;
    expect(run(withTail(12, 4, tail), 'pool_in_use')).toEqual([]);
    tail[10] = 10_000;
    expect(run(withTail(12, 4, tail), 'pool_in_use')).toEqual([]);
  });

  it('never flags two adjacent strong samples', () => {
    const tail = Array.from({ length: 30 }, () => 100_000);
    tail[5] = 900_000;
    tail[6] = 900_000;
    expect(run(withTail(100_000, 10_000, tail))).toEqual([]);
  });

  it('ignores wiggles below the absolute floor on a flat zero baseline (MAD = 0)', () => {
    const values = [
      ...Array.from({ length: 60 }, () => 0),
      ...Array.from({ length: 20 }, () => 0.005),
    ];
    expect(run(values, 'error_rate')).toEqual([]);
  });

  it('skips a series with too few baseline samples, with the reason', () => {
    const r = detectAnomalies(series('svc', 'latency_p99', [1, 2, 3]), { baseline: BASE });
    expect(r).toMatchObject({ service: 'svc', metric: 'latency_p99' });
    expect(Array.isArray(r)).toBe(false);
  });
});

describe('anomaly detector: known answers', () => {
  it('finds a step change at the right sample, ongoing, with magnitude and evidence', () => {
    const values = withTail(
      100_000,
      5_000,
      Array.from({ length: 30 }, () => 400_000),
    );
    const [a, ...rest] = run(values);
    expect(rest).toEqual([]);
    expect(a).toMatchObject<Partial<Anomaly>>({
      direction: 'up',
      onsetUs: at(60),
      firstExceedanceUs: at(60),
      changePointUs: at(60),
      onsetResolutionUs: TICK,
      status: 'ongoing',
      endUs: null,
      rule: 'strong-run',
      samples: 30,
    });
    expect(a?.ratio).toBeCloseTo(4, 1);
    expect(a?.value.median).toBe(400_000);
    expect(a?.evidenceIds).toContain(metricEvidenceId('svc', 'latency_p99', at(60)));
    expect(a?.baseline.medianEvidenceIds.length).toBeGreaterThan(0);
    expect(a?.confidence.level).toBe('high');
  });

  it('reports a transient blip as recovered, with its end', () => {
    const tail = [
      ...Array.from({ length: 4 }, () => 400_000),
      ...Array.from({ length: 20 }, () => 100_000),
    ];
    const [a] = run(withTail(100_000, 5_000, tail));
    expect(a).toMatchObject({ onsetUs: at(60), status: 'recovered', endUs: at(64), samples: 4 });
  });

  it('detects a decrease', () => {
    const [a] = run(
      withTail(
        400,
        20,
        Array.from({ length: 20 }, () => 60),
      ),
      'request_rate',
    );
    expect(a).toMatchObject({ direction: 'down', onsetUs: at(60) });
  });

  it('detects a sustained moderate shift in a noisy point-sampled gauge (not a single spike)', () => {
    // Baseline 12 ± 8 (sigma ≈ 6): 30 is only ~3 sigma per sample, so no strong run, but six or
    // more consecutive samples beyond 2 sigma are a sustained shift.
    const base = noise(60, 3, 8).map((n) => Math.round(12 + n));
    const [a] = run([...base, ...Array.from({ length: 20 }, () => 30)], 'pool_in_use');
    expect(a).toMatchObject({ rule: 'sustained-run', onsetUs: at(60), status: 'ongoing' });
    // Five samples of the same shift are not enough.
    expect(
      run(
        [...base, ...Array.from({ length: 5 }, () => 30), ...Array.from({ length: 20 }, () => 12)],
        'pool_in_use',
      ),
    ).toEqual([]);
  });

  it('widens the onset interval over a noisy sample next to the shift instead of moving it', () => {
    const base = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 95_000 : 105_000));
    // Sample 60 is moderately high (could be noise or the start), then the real strong shift.
    const [a] = run([...base, 127_000, ...Array.from({ length: 10 }, () => 400_000)]);
    expect(a?.firstExceedanceUs).toBe(at(60));
    expect(a?.onsetUs).toBe(at(61));
    expect(a?.onsetResolutionUs).toBe(2 * TICK);
  });

  it('puts the CUSUM change point at the start of a gradual ramp', () => {
    const base = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 98_000 : 102_000));
    const ramp = Array.from({ length: 12 }, (_, i) => 100_000 + (i + 1) * 15_000);
    const [a] = run([...base, ...ramp]);
    expect(a).toBeDefined();
    expect(a?.changePointUs).toBeLessThanOrEqual(a?.onsetUs ?? 0);
    expect(a?.changePointUs).toBeGreaterThanOrEqual(at(60));
  });

  it('finds two separate anomalies in one series', () => {
    const tail = [
      ...Array.from({ length: 4 }, () => 400_000),
      ...Array.from({ length: 10 }, () => 100_000),
      ...Array.from({ length: 10 }, () => 500_000),
    ];
    const found = run(withTail(100_000, 5_000, tail));
    expect(found.map((a) => [a.onsetUs, a.status])).toEqual([
      [at(60), 'recovered'],
      [at(74), 'ongoing'],
    ]);
  });

  it('scans many series and orders anomalies by onset', () => {
    const a = series(
      'a',
      'latency_p99',
      withTail(
        100,
        0,
        Array.from({ length: 10 }, () => 100),
      ),
    );
    const b = series('b', 'error_rate', [
      ...Array.from({ length: 62 }, () => 0),
      ...Array.from({ length: 10 }, () => 0.5),
    ]);
    const c = series('c', 'error_rate', [
      ...Array.from({ length: 61 }, () => 0),
      ...Array.from({ length: 10 }, () => 0.5),
    ]);
    const scan = scanAnomalies([a, b, c], { baseline: BASE });
    expect(scan.anomalies.map((x) => x.service)).toEqual(['c', 'b']);
  });
});
