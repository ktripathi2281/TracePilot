// Knob addressing shared by scheduled change events and counterfactual patches (brief §3).
//
// A knob target is `<component>.<key>`: `db.pool.capacity`, `db.acquireTimeoutUs`,
// `db.maxParallelQueries`, `<service>.workers|replicas|queueLimit|timeoutUs`,
// `<service>.params.<name>`.

import {
  isRevertPatch,
  isVariantPatch,
  type ModelVariant,
  type Patch,
  type VariantPatch,
} from '@tracepilot/schema';
import {
  DB_SERVICE,
  assertValidConfig,
  type SimConfig,
  type Step,
  type SystemModel,
} from './model.ts';

const SERVICE_KNOBS = ['workers', 'replicas', 'queueLimit', 'timeoutUs'] as const;
type ServiceKnobKey = (typeof SERVICE_KNOBS)[number];
const isServiceKnob = (k: string): k is ServiceKnobKey =>
  (SERVICE_KNOBS as readonly string[]).includes(k);

/** Knobs the patch grammar allows but this engine does not model yet. */
const NOT_MODELED: Readonly<Record<string, string>> = {
  memoryLimit: 'pod memory limits arrive with the pod lifecycle model (Scenario D)',
  cpuLimit: 'pod CPU limits arrive with the pod lifecycle model (Scenario D)',
  consumers: 'the topology has no message queue component',
};

export class UnsupportedKnobError extends Error {}

/** Structural variants this engine can simulate. The patch grammar lists more (MODEL_VARIANTS). */
export const MODELED_VARIANTS: readonly ModelVariant[] = ['release-connection-before-calls'];

const holdsAcrossCalls = (steps: readonly Step[]): boolean =>
  steps.some((s) => s.kind !== 'query' && s.kind !== 'compute' && s.kind !== 'transaction');

/**
 * `release-connection-before-calls`: every transaction of the service that keeps its connection
 * while it runs non-DB steps (calls, parallel branches, fan-out) releases it around them instead.
 * Returns the number of transactions changed.
 */
function applyVariant(model: SystemModel, patch: VariantPatch): number {
  if (!MODELED_VARIANTS.includes(patch.variant))
    throw new UnsupportedKnobError(
      `variant ${patch.variant} is not modeled by this simulator (modeled: ${MODELED_VARIANTS.join(', ')})`,
    );
  const svc = model.services[patch.service];
  if (svc === undefined)
    throw new UnsupportedKnobError(
      `variant ${patch.variant}: no service "${patch.service}" in this model`,
    );
  let changed = 0;
  const visit = (steps: Step[]): void => {
    for (const s of steps) {
      if (s.kind === 'transaction' && holdsAcrossCalls(s.steps)) {
        s.release = 'around-calls';
        changed++;
      }
      if (s.kind === 'parallel') s.branches.forEach(visit);
      else if (s.kind === 'fanout' || s.kind === 'transaction') visit(s.steps);
    }
  };
  for (const op of Object.values(svc.operations)) visit(op.steps);
  if (changed === 0)
    throw new UnsupportedKnobError(
      `variant ${patch.variant}: ${patch.service} has no transaction that holds its connection across other steps`,
    );
  return changed;
}

export function getKnob(model: SystemModel, target: string): number | undefined {
  const dot = target.indexOf('.');
  if (dot <= 0) return undefined;
  const component = target.slice(0, dot);
  const key = target.slice(dot + 1);
  if (component === DB_SERVICE) {
    if (key === 'pool.capacity') return model.db.pool.capacity;
    if (key === 'acquireTimeoutUs') return model.db.acquireTimeoutUs;
    if (key === 'maxParallelQueries') return model.db.maxParallelQueries;
    return undefined;
  }
  const svc = model.services[component];
  if (svc === undefined) return undefined;
  if (isServiceKnob(key)) return svc[key];
  if (key.startsWith('params.')) return svc.params[key.slice('params.'.length)];
  return undefined;
}

/** Sets a knob in place. Returns false when the target is not a knob of this model. */
export function setKnob(model: SystemModel, target: string, value: number): boolean {
  if (getKnob(model, target) === undefined) return false;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`knob ${target}: value must be a non-negative integer, got ${String(value)}`);
  }
  const dot = target.indexOf('.');
  const component = target.slice(0, dot);
  const key = target.slice(dot + 1);
  const needPositive = (): void => {
    if (value < 1) throw new Error(`knob ${target}: value must be >= 1`);
  };
  if (component === DB_SERVICE) {
    needPositive();
    if (key === 'pool.capacity') model.db.pool.capacity = value;
    else if (key === 'acquireTimeoutUs') model.db.acquireTimeoutUs = value;
    else model.db.maxParallelQueries = value;
    return true;
  }
  const svc = model.services[component];
  if (svc === undefined) return false;
  if (isServiceKnob(key)) {
    if (key !== 'queueLimit') needPositive();
    svc[key] = value;
  } else {
    svc.params[key.slice('params.'.length)] = value;
  }
  return true;
}

/**
 * Applies counterfactual patches to a recorded config and returns a NEW config.
 *
 * - `{target, to}` pins the knob to `to` for the WHOLE run: the base value is set and scheduled
 *   change events no longer alter that knob (the rest of such an event still applies). So
 *   `checkout.workers=20` means "workers stay 20 even though the deploy raised them".
 * - `{revert: id}` removes that scheduled change event entirely, as if it never happened.
 * - `{variant, service}` changes how the service works (a structural model variant).
 *
 * `from` on a set-patch is informational and not checked: it usually names the post-change value.
 */
export function applyPatches(config: SimConfig, patches: readonly Patch[]): SimConfig {
  const next = structuredClone(config);
  const pins = new Set(next.pins);
  for (const patch of patches) {
    if (isVariantPatch(patch)) {
      applyVariant(next.model, patch);
      continue;
    }
    if (isRevertPatch(patch)) {
      const before = next.changes.length;
      next.changes = next.changes.filter((c) => c.id !== patch.revert);
      if (next.changes.length === before) {
        throw new Error(`cannot revert ${patch.revert}: no such change event in this recording`);
      }
      continue;
    }
    const key = patch.target.slice(patch.target.indexOf('.') + 1);
    const why =
      NOT_MODELED[key] ?? (patch.target === 'cache.capacity' ? 'no cache is modeled' : undefined);
    if (why !== undefined) {
      throw new UnsupportedKnobError(`patch target ${patch.target} is not supported: ${why}`);
    }
    if (!setKnob(next.model, patch.target, patch.to)) {
      throw new UnsupportedKnobError(`patch target ${patch.target} does not exist in this model`);
    }
    pins.add(patch.target);
  }
  next.pins = [...pins].sort();
  assertValidConfig(next);
  return next;
}
