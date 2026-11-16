import { describe, expect, it } from 'vitest';
import { UnsupportedKnobError, applyPatches, getKnob, setKnob } from './knobs.ts';
import { Recording, SimConfig, findConfigProblems } from './model.ts';
import { poolExhaustionConfig, recordPoolExhaustion } from './scenarios/pool-exhaustion.ts';
import { recordScenario } from './scenarios/index.ts';

describe('knobs', () => {
  it('reads and writes every supported target', () => {
    const { model } = poolExhaustionConfig();
    expect(getKnob(model, 'db.pool.capacity')).toBe(30);
    expect(getKnob(model, 'db.acquireTimeoutUs')).toBe(5_000_000);
    expect(getKnob(model, 'db.maxParallelQueries')).toBe(24);
    expect(getKnob(model, 'checkout.workers')).toBe(20);
    expect(getKnob(model, 'inventory.replicas')).toBe(2);
    expect(getKnob(model, 'checkout.queueLimit')).toBe(40);
    expect(getKnob(model, 'checkout.params.reserveFanout')).toBe(1);
    expect(getKnob(model, 'nope.workers')).toBeUndefined();
    expect(getKnob(model, 'checkout.version')).toBeUndefined();
    expect(setKnob(model, 'checkout.params.reserveFanout', 4)).toBe(true);
    expect(model.services['checkout']?.params['reserveFanout']).toBe(4);
    expect(setKnob(model, 'checkout.version', 3)).toBe(false);
    expect(() => setKnob(model, 'checkout.workers', 0)).toThrow();
    expect(() => setKnob(model, 'db.pool.capacity', 1.5)).toThrow();
    expect(setKnob(model, 'checkout.queueLimit', 0)).toBe(true);
  });
});

describe('applyPatches', () => {
  const config = poolExhaustionConfig();

  it('pins a knob and leaves the input untouched', () => {
    const next = applyPatches(config, [{ target: 'db.pool.capacity', from: 30, to: 64 }]);
    expect(next.model.db.pool.capacity).toBe(64);
    expect(next.pins).toEqual(['db.pool.capacity']);
    expect(config.model.db.pool.capacity).toBe(30);
    expect(config.pins).toEqual([]);
  });

  it('reverts a change event', () => {
    const next = applyPatches(config, [{ revert: 'ev_2' }]);
    expect(next.changes.map((c) => c.id)).toEqual(['ev_1']);
    expect(() => applyPatches(config, [{ revert: 'ev_99' }])).toThrow(/no such change event/);
  });

  it('combines patches', () => {
    const next = applyPatches(config, [
      { target: 'checkout.workers', to: 20 },
      { target: 'inventory.replicas', to: 3 },
      { revert: 'ev_1' },
    ]);
    expect(next.pins).toEqual(['checkout.workers', 'inventory.replicas']);
    expect(next.model.services['inventory']?.replicas).toBe(3);
    expect(next.changes).toHaveLength(1);
  });

  it('refuses knobs that are not modeled, with a reason', () => {
    expect(() => applyPatches(config, [{ target: 'cache.capacity', to: 10 }])).toThrow(
      UnsupportedKnobError,
    );
    expect(() => applyPatches(config, [{ target: 'checkout.memoryLimit', to: 10 }])).toThrow(
      /Scenario D/,
    );
    expect(() => applyPatches(config, [{ target: 'orders.consumers', to: 2 }])).toThrow(
      /message queue/,
    );
    expect(() => applyPatches(config, [{ target: 'ghost.workers', to: 2 }])).toThrow(
      /does not exist/,
    );
    expect(() => applyPatches(config, [{ target: 'checkout.workers', to: 0 }])).toThrow();
  });
});

describe('model variants', () => {
  const config = poolExhaustionConfig();
  const tx = (c: typeof config) => {
    const steps = c.model.services['checkout']?.operations['place-order']?.steps ?? [];
    return steps.find((s) => s.kind === 'transaction');
  };

  it('release-connection-before-calls marks the transactions that hold a connection across calls', () => {
    const next = applyPatches(config, [
      { variant: 'release-connection-before-calls', service: 'checkout' },
    ]);
    expect(tx(next)).toMatchObject({
      kind: 'transaction',
      label: 'order-tx',
      release: 'around-calls',
    });
    expect(tx(config)).not.toHaveProperty('release');
    // A structural variant pins no knob.
    expect(next.pins).toEqual([]);
    expect(SimConfig.parse(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });

  it('is refused where it does not apply', () => {
    expect(() =>
      applyPatches(config, [{ variant: 'release-connection-before-calls', service: 'payment' }]),
    ).toThrow(UnsupportedKnobError);
    expect(() =>
      applyPatches(config, [{ variant: 'release-connection-before-calls', service: 'billing' }]),
    ).toThrow(/no service "billing"/);
  });
});

describe('config validation', () => {
  it('accepts scenario A and round-trips through JSON', () => {
    const rec = recordPoolExhaustion(1, { durationUs: 10_000_000 });
    expect(findConfigProblems(rec.config)).toEqual([]);
    expect(Recording.parse(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(() => recordScenario('nope', 1)).toThrow(/unknown scenario/);
  });

  it('reports semantic problems the schema cannot express', () => {
    const bad = SimConfig.parse(JSON.parse(JSON.stringify(poolExhaustionConfig())));
    const checkout = bad.model.services['checkout'];
    const gateway = bad.model.services['api-gateway'];
    if (checkout === undefined || gateway === undefined) throw new Error('scenario changed');
    checkout.params = {};
    gateway.operations['stock']?.steps.push({
      kind: 'call',
      label: 'route',
      service: 'ghost',
      operation: 'x',
    });
    bad.changes.push({ ...(bad.changes[0] as (typeof bad.changes)[number]) });
    bad.changes.push({
      id: 'ev_9',
      ts: 1,
      kind: 'config',
      service: 'payment',
      description: 'x',
      diff: { replicas: { from: 2, to: 3 } },
    });
    bad.disturbances.push({
      description: 'd',
      startUs: 0,
      endUs: 1,
      service: 'payment',
      step: 'missing',
      factor: 2,
    });
    const problems = findConfigProblems(bad).join('\n');
    expect(problems).toMatch(/fanout reads unknown param "reserveFanout"/);
    expect(problems).toMatch(/duplicate step label "route"/);
    expect(problems).toMatch(/call to unknown ghost.x/);
    expect(problems).toMatch(/duplicate change event id ev_1/);
    expect(problems).toMatch(/replicas is a static knob/);
    expect(problems).toMatch(/no step payment\/missing/);
  });

  it('rejects call cycles', () => {
    const cyclic = poolExhaustionConfig();
    cyclic.model.services['inventory']?.operations['reserve']?.steps.push({
      kind: 'call',
      label: 'loop',
      service: 'checkout',
      operation: 'place-order',
    });
    expect(findConfigProblems(cyclic).join('\n')).toMatch(/call cycle/);
  });
});
