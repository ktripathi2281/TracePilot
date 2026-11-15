import { describe, expect, it } from 'vitest';
import { fixed } from './testkit.ts';
import { mulberry32, sampleDist, spanIdFor, traceIdFor, uniform } from './rng.ts';
import { generateWorkload } from './workload.ts';

describe('keyed uniform', () => {
  it('is uniform on [0, 1)', () => {
    const n = 50_000;
    const buckets = new Array<number>(20).fill(0);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const u = uniform(7, i, 'svc/op/step');
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      sum += u;
      const b = Math.floor(u * 20);
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
    // Chi-square against uniform with 19 degrees of freedom: 43.8 is the 0.1% critical value.
    const expected = n / 20;
    const chi2 = buckets.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(43.8);
  });

  it('gives uncorrelated values for neighbouring requests and for different labels', () => {
    const n = 20_000;
    const corr = (xs: number[], ys: number[]): number => {
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < n; i++) {
        const dx = (xs[i] as number) - mx;
        const dy = (ys[i] as number) - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
      }
      return sxy / Math.sqrt(sxx * syy);
    };
    const a = Array.from({ length: n }, (_, i) => uniform(3, i, 'x/step'));
    const next = Array.from({ length: n }, (_, i) => uniform(3, i + 1, 'x/step'));
    const otherLabel = Array.from({ length: n }, (_, i) => uniform(3, i, 'x/step[1]'));
    const otherSeed = Array.from({ length: n }, (_, i) => uniform(4, i, 'x/step'));
    for (const other of [next, otherLabel, otherSeed])
      expect(Math.abs(corr(a, other))).toBeLessThan(0.03);
  });
});

describe('distributions', () => {
  it('lognormal has the requested median and spread', () => {
    const n = 40_000;
    const xs = Array.from({ length: n }, (_, i) =>
      sampleDist({ kind: 'lognormal', medianUs: 50_000, sigma: 0.3 }, 11, i, 'q'),
    ).sort((x, y) => x - y);
    expect(xs[n / 2]).toBeGreaterThan(49_000);
    expect(xs[n / 2]).toBeLessThan(51_000);
    // p99 of lognormal = median * exp(2.326 * sigma)
    const p99 = xs[Math.floor(n * 0.99)] as number;
    expect(p99 / (50_000 * Math.exp(2.326 * 0.3))).toBeGreaterThan(0.95);
    expect(p99 / (50_000 * Math.exp(2.326 * 0.3))).toBeLessThan(1.05);
    expect(xs.every((x) => Number.isInteger(x) && x >= 1)).toBe(true);
  });

  it('exponential has the requested mean; constant is constant', () => {
    const n = 40_000;
    let sum = 0;
    for (let i = 0; i < n; i++)
      sum += sampleDist({ kind: 'exponential', meanUs: 10_000 }, 5, i, 'e');
    expect(sum / n / 10_000).toBeGreaterThan(0.97);
    expect(sum / n / 10_000).toBeLessThan(1.03);
    expect(sampleDist(fixed(7), 1, 2, 'c')).toBe(7_000);
  });
});

describe('ids', () => {
  it('span ids are stable, well-formed and unique across requests and paths', () => {
    const seen = new Set<string>();
    for (let req = 0; req < 20_000; req++) {
      for (const path of [
        'checkout',
        'checkout/place-order',
        'checkout/place-order/order-tx/fulfil[0]/reserve[3]/inventory',
      ]) {
        const id = spanIdFor(42, req, path);
        expect(id).toMatch(/^[0-9a-f]{16}$/);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(60_000);
    expect(spanIdFor(42, 5, 'checkout')).toBe(spanIdFor(42, 5, 'checkout'));
    expect(traceIdFor(42, 5)).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdFor(42, 5)).not.toBe(traceIdFor(42, 6));
  });
});

describe('workload generation', () => {
  const spec = {
    durationUs: 60_000_000,
    types: { checkout: { ratePerS: 80 }, stock: { ratePerS: 40 } },
  };

  it('is deterministic per seed and sorted by arrival', () => {
    const a = generateWorkload(spec, 9);
    expect(generateWorkload(spec, 9)).toEqual(a);
    expect(generateWorkload(spec, 10)).not.toEqual(a);
    expect(a.seed).toBe(9);
    expect(a.requests.every((r, i) => r.requestId === i)).toBe(true);
    expect(
      a.requests.every((r, i) => i === 0 || r.arrivalUs >= (a.requests[i - 1]?.arrivalUs ?? 0)),
    ).toBe(true);
    expect(a.requests.every((r) => r.arrivalUs > 0 && r.arrivalUs < spec.durationUs)).toBe(true);
  });

  it('produces Poisson arrivals at the requested rates', () => {
    const w = generateWorkload(spec, 9);
    const checkout = w.requests.filter((r) => r.type === 'checkout');
    const stock = w.requests.filter((r) => r.type === 'stock');
    // Poisson(4800) has sd ~69; allow 4 sd.
    expect(Math.abs(checkout.length - 4800)).toBeLessThan(280);
    expect(Math.abs(stock.length - 2400)).toBeLessThan(200);
    // Exponential gaps: coefficient of variation ~1.
    const gaps = checkout.slice(1).map((r, i) => r.arrivalUs - (checkout[i]?.arrivalUs ?? 0));
    const mean = gaps.reduce((x, y) => x + y, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((x, y) => x + (y - mean) ** 2, 0) / gaps.length);
    expect(sd / mean).toBeGreaterThan(0.9);
    expect(sd / mean).toBeLessThan(1.1);
  });

  it('one type’s arrivals do not depend on the other type’s rate', () => {
    const both = generateWorkload(spec, 9).requests.filter((r) => r.type === 'checkout');
    const alone = generateWorkload({ ...spec, types: { checkout: { ratePerS: 80 } } }, 9).requests;
    expect(alone.map((r) => r.arrivalUs)).toEqual(both.map((r) => r.arrivalUs));
  });

  it('mulberry32 is a deterministic stream', () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
